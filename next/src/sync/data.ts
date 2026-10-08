// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The data layer's entry point (PLAN §5.2, §5.3): opens the user's
// database, hydrates the pool (structure + the route's groups first, the
// rest when idle), elects the leader tab and, in the leader, runs the
// persister and the sync client. Followers mirror IndexedDB from the
// leader's flush announcements and forward their holds and requests.
//
//   const data = await openData({userId, auth});
//   data.hold('repo:12');               // this tab shows repo:12
//   await data.firstRoute;              // structure + held groups are in the pool
//   data.pool.model('Issue').by('repo_id', 12)

import {autorun, observable, runInAction} from 'mobx';
import {forgetUser, writeSplash} from '../app/splash.ts';
import {type HydrateStats, Hydrator} from '../data/hydrate.ts';
import {deleteDatabase, INTENTS, openDatabase, readMeta, request} from '../data/idb.ts';
import {MetaCache} from '../data/meta.ts';
import {groupKind, type ModelName, type ModelTypes, STRUCTURE_KINDS} from '../data/models.ts';
import type {Persister} from '../data/persist.ts';
import {Pool} from '../data/pool.ts';
import type {Workspace} from '../protocol/types.gen.ts';
import type {SyncAuth, SyncClient, SyncEvents, SyncStatus} from './client.ts';
import {markOnce, measure} from './rum.ts';
import {type TabMessage, Tabs, type TabsEnv} from './tabs.ts';
import type {TransportEnv} from './transport.ts';

export interface DataOptions {
  userId: number;
  auth: SyncAuth;
  /** Default "/-/sync". */
  endpoint?: string;
  buildId?: string;
  transport?: 'auto' | 'ws' | 'sse';
  /** Groups the current route shows: hydrated first and held by this tab. */
  route?: string[];
  /** Models peeked at in phase 1 (see Data.peek; default Repository: the sidebar and route lookups by name). */
  peekModels?: readonly ModelName[];
  /** Ask the browser not to evict the database (default true). */
  persistStorage?: boolean;
  env?: TabsEnv & {indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange; transport?: TransportEnv};
  /**
   * This tab was elected leader but cannot lead (its sync modules failed to
   * load). It has given up the leadership already; the app should reload.
   */
  onFatal?: (err: unknown) => void;
  /** Tab holds of tabs not heard from for this long are dropped (ms, default 60 s). */
  tabTimeout?: number;
}

export interface Data {
  readonly userId: number;
  readonly pool: Pool;
  /** The sync status (mirrored from the leader in follower tabs). */
  readonly status: SyncStatus;
  /** Whether this tab is the leader. Observable. */
  readonly role: {leader: boolean};
  /** Structure and the route's groups are in the pool. */
  readonly firstRoute: Promise<HydrateStats>;
  /** Everything persisted is in the pool. */
  readonly hydrated: Promise<HydrateStats>;
  /** The viewer's workspace as last fetched (GET /-/sync/workspace; persisted). Observable (`current`). */
  readonly workspace: {current: Workspace | undefined};
  /** Resolves once everything IndexedDB holds of these groups is in the pool (it does not hold them). */
  hydrate(groups: string[]): Promise<void>;
  /** Intents not synced yet (the offline queue, F5). */
  countIntents(): Promise<number>;
  /**
   * What IndexedDB held of a peeked model (DataOptions.peekModels) when the
   * first route was read: for the first frame, before the groups of those
   * entities are hydrated (prefer the pool's entity when it is there). Not
   * observable, not updated, and empty once everything is hydrated.
   */
  peek<M extends ModelName>(m: M): ReadonlyMap<number, ModelTypes[M]>;
  /** This tab shows a group: load it (if needed) and keep it live. */
  hold(group: string): void;
  release(group: string): void;
  pin(group: string, on: boolean): void;
  /** See SyncClient.barrier. */
  barrier(): Promise<number>;
  /**
   * Resolves once this tab's pool holds every entry of `group` up to sync id
   * `v` (B7's X-Livesync-Sync-Id echo): in the leader when the group's
   * position reaches `v`; in a follower once the leader persisted that state
   * and this tab mirrored it. Optimistic overlays drop then, without flicker.
   */
  whenSynced(group: string, v: number): Promise<void>;
  /** See SyncClient.loadClosedPage. */
  loadClosedPage(group: string, before?: string, limit?: number): Promise<{next: string | undefined; count: number}>;
  on<K extends keyof SyncEvents>(name: K, fn: (e: SyncEvents[K]) => void): () => void;
  /** Flushes and stops (the tab gives up leadership). */
  close(): Promise<void>;
}

const HEARTBEAT = 20_000;

/**
 * The leader's modules (the sync client and the persister) are not needed
 * for the first frame: a follower never loads them, and the leader starts
 * syncing only after the first route is hydrated. The leader loads them in
 * parallel with that hydration, so they are off the boot route's bundle
 * without delaying sync. (Offline with an empty HTTP cache they cannot load
 * and this tab does not sync until reloaded; F5's service worker precaches
 * every chunk.)
 */
function leaderModules(): Promise<[{SyncClient: typeof SyncClient}, {Persister: typeof Persister}]> {
  return Promise.all([import('./client.ts'), import('../data/persist.ts')]);
}

export async function openData(opts: DataOptions): Promise<Data> {
  const t0 = performance.now();
  const {userId} = opts;
  const factory = opts.env?.indexedDB;
  const db = await openDatabase(userId, {
    ...(factory ? {factory} : {}),
    onVersionChange: () => {
      // Another tab upgrades or deletes the database: this one cannot go on.
      void data.close();
    },
  });
  writeSplash({user: String(userId)});
  // Optional chaining: not every browser (or test environment) has the Storage API.
  const storage = (navigator as Partial<Navigator>).storage;
  if (opts.persistStorage !== false && typeof storage?.persist === 'function') void storage.persist().catch(() => false);

  const pool = new Pool();
  const tabs = new Tabs(`forgejo-next:${userId}`, opts.env ?? {});
  const role = observable({leader: false});
  const status: SyncStatus = observable({
    connection: 'idle', transport: undefined, loading: 0, groups: 0, serverSyncId: 0, lastError: undefined,
  }, {}, {deep: false});
  const listeners = new Map<string, Set<(e: never) => void>>();
  const workspace = observable({current: undefined as Workspace | undefined}, {}, {deep: false});
  listeners.set('workspace', new Set([(e: SyncEvents['workspace']) => {
    // Every session fetches it; observers only hear about a real change.
    if (JSON.stringify(e.workspace) === JSON.stringify(workspace.current)) return;
    runInAction(() => {
      workspace.current = e.workspace;
    });
  }]));

  const emit = <K extends keyof SyncEvents>(name: K, e: SyncEvents[K]) => {
    for (const fn of listeners.get(name) ?? []) (fn as (e: SyncEvents[K]) => void)(e);
  };
  const myHolds = new Map<string, number>();
  const holder = `tab:${tabs.id}`;
  /** Another tab led at some point: this tab's pool mirrored it and may have missed an announcement. */
  let sawLeader = !tabs.hasChannel && tabs.hasLocks;
  /** This tab took over (set before the client exists: hydration then loads instead of mirroring). */
  let leading = false;
  let client: SyncClient | undefined;
  let persister: Persister | undefined;
  let closed = false;
  const cleanups: (() => void)[] = [];

  // Follower: mirror IndexedDB. Leader: load through the version check.
  const hydrator = new Hydrator(db, (m, recs, seq) => {
    pool.batch(() => {
      if (leading) pool.load(m, recs);
      else for (const r of recs) pool.mirror(m, r.id, r, seq);
    });
  }, opts.env?.IDBKeyRange);
  hydrator.trackSeen = true;

  const mirrorCommit = (c: Extract<TabMessage, {t: 'commit'}>) => {
    pool.batch(() => {
      for (const m of c.cleared) pool.clearModel(m, c.seq);
      for (const g of c.dropped) pool.mirrorDropGroup(g, c.seq);
      for (const w of c.buckets) pool.mirrorBucket(w.m, w.g, w.b, w.r, c.seq);
    });
  };

  // Leader-side bookkeeping of follower tabs.
  const tabSeen = new Map<string, number>();
  const tabHolds = new Map<string, Set<string>>();
  const timeout = opts.tabTimeout ?? 3 * HEARTBEAT;

  // Requests wait for a leader: another tab's (posted, posted again to a new leader) or this
  // tab's own once it took over (run locally then).
  interface Pending {
    op: string;
    args: unknown[];
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }
  const requests = new Map<number, Pending>();
  let reqSeq = 0;
  const ask = <T>(op: string, ...args: unknown[]): Promise<T> => {
    if (client) return local(op, args) as Promise<T>;
    const id = ++reqSeq;
    return new Promise<T>((resolve, reject) => {
      requests.set(id, {op, args, resolve: resolve as (v: unknown) => void, reject});
      tabs.post({t: 'req', tab: tabs.id, id, op, args});
    });
  };
  const runPendingLocally = () => {
    for (const r of requests.values()) local(r.op, r.args).then(r.resolve, r.reject);
    requests.clear();
  };
  const local = (op: string, args: unknown[]): Promise<unknown> => {
    if (!client) return Promise.reject(new Error('not the leader'));
    switch (op) {
      case 'barrier':
        return client.barrier();
      case 'closedPage':
        return client.loadClosedPage(args[0] as string, args[1] as string | undefined, args[2] as number | undefined);
      case 'pin':
        client.pin(args[0] as string, args[1] as boolean);
        return Promise.resolve();
      case 'synced': {
        // A follower asks: the state at v must be in IndexedDB, announced (commit) before the answer.
        const p = persister;
        return client.whenAt(args[0] as string, args[1] as number).then(() => p?.flush());
      }
    }
    return Promise.reject(new Error(`unknown request ${op}`));
  };

  cleanups.push(tabs.onMessage((m) => {
    switch (m.t) {
      case 'commit':
        sawLeader = true;
        if (!leading) mirrorCommit(m);
        break;
      case 'status':
        sawLeader = true;
        if (!leading) runInAction(() => Object.assign(status, m.status));
        break;
      case 'event':
        if (!leading) emit(m.name, m.e as never);
        break;
      case 'leader':
        sawLeader = true;
        if (!leading) {
          tabs.post({t: 'alive', tab: tabs.id, holds: [...myHolds.keys()]});
          // Requests to the previous leader may be lost: ask the new one (they are idempotent).
          for (const [id, r] of requests) tabs.post({t: 'req', tab: tabs.id, id, op: r.op, args: r.args});
        }
        break;
      case 'res':
        if (m.tab === tabs.id) {
          const r = requests.get(m.id);
          requests.delete(m.id);
          if (m.ok) r?.resolve(m.value);
          else r?.reject(new Error(m.error ?? 'failed'));
        }
        break;
      default:
        if (role.leader && client) leaderMessage(client, m);
    }
  }));

  const leaderMessage = (c: SyncClient, m: TabMessage) => {
    switch (m.t) {
      case 'hello':
        tabSeen.set(m.tab, Date.now());
        tabs.post({t: 'status', status: {...status}});
        break;
      case 'alive': {
        tabSeen.set(m.tab, Date.now());
        const want = new Set(m.holds);
        const had = tabHolds.get(m.tab) ?? new Set();
        for (const g of had) if (!want.has(g)) c.release(g, `tab:${m.tab}`);
        for (const g of want) if (!had.has(g)) c.hold(g, `tab:${m.tab}`);
        tabHolds.set(m.tab, want);
        break;
      }
      case 'hold': {
        tabSeen.set(m.tab, Date.now());
        let set = tabHolds.get(m.tab);
        if (!set) tabHolds.set(m.tab, set = new Set());
        if (m.on) {
          set.add(m.group);
          c.hold(m.group, `tab:${m.tab}`);
        } else {
          set.delete(m.group);
          c.release(m.group, `tab:${m.tab}`);
        }
        break;
      }
      case 'bye':
        tabSeen.delete(m.tab);
        tabHolds.delete(m.tab);
        c.releaseHolder(`tab:${m.tab}`);
        break;
      case 'req':
        local(m.op, m.args).then(
          (value) => {
            tabs.post({t: 'res', tab: m.tab, id: m.id, ok: true, value});
          },
          (err: unknown) => {
            tabs.post({t: 'res', tab: m.tab, id: m.id, ok: false, error: String(err)});
          },
        );
        break;
    }
  };

  // Phase 1: the structure groups and the route's groups.
  const meta0 = await readMeta(db);
  const first: string[] = [...opts.route ?? []];
  for (const k of meta0.keys()) {
    if (!k.startsWith('group:')) continue;
    const g = k.slice('group:'.length);
    const kind = groupKind(g);
    if (kind && STRUCTURE_KINDS.includes(kind)) first.push(g);
  }
  for (const g of opts.route ?? []) myHolds.set(g, 1);
  const ws0 = meta0.get('workspace') as Workspace | undefined;
  if (ws0) runInAction(() => {
    workspace.current = ws0;
  });
  let peeked = new Map<ModelName, Map<number, unknown>>();
  const firstRoute = Promise.all([hydrator.groups(first), hydrator.peek(opts.peekModels ?? ['Repository'])]).then(([s, recs]) => {
    for (const [m, list] of recs) peeked.set(m, new Map(list.map((r) => [r.id, r.d])));
    measure('hydrate:route', t0);
    return s;
  });
  const hydrated = firstRoute.then(() => hydrator.rest()).then((s) => {
    peeked = new Map();
    measure('hydrate:all', t0);
    return s;
  });

  // A function: TypeScript would narrow a plain read across the awaits below.
  const isClosed = () => closed;
  const promote = async () => {
    if (isClosed()) return;
    const modules = leaderModules();
    modules.catch(() => undefined); // awaited below; not unhandled if closing returns first
    hydrator.eager = true;
    if (sawLeader) {
      // Another tab led: take IndexedDB as the truth (a flush announcement lost when the old
      // leader died is caught here), then lead from a pool that equals it.
      await hydrated;
      await hydrator.rereadAll();
      pool.batch(() => {
        pool.retainSeen(hydrator.seen, hydrator.oldestSeq);
      });
    } else {
      // The first tab: sync as soon as the first frame's data is there; the rest hydrates
      // meanwhile through the version check, and nothing of a group is written before it is
      // hydrated (the persister defers it).
      await firstRoute;
    }
    let loaded: Awaited<typeof modules>;
    try {
      loaded = await modules;
    } catch (err) {
      // Holding the leader lock without leading would stop every tab of the user from syncing.
      runInAction(() => Object.assign(status, {lastError: String(err)}));
      tabs.close();
      opts.onFatal?.(err);
      return;
    }
    const [{SyncClient}, {Persister}] = loaded;
    if (isClosed()) return;
    leading = true;
    hydrator.trackSeen = false;
    hydrator.seen.clear();
    if (isClosed()) return;
    pool.takeDirty();
    const meta = new MetaCache(await readMeta(db));
    const p = new Persister(db, pool, meta, {
      seq: meta.get<number>('flushedSeq') ?? 0,
      ...(opts.env?.IDBKeyRange ? {keyRange: opts.env.IDBKeyRange} : {}),
      defer: (g) => !hydrator.isHydrated(g) || (client?.isLoading(g) ?? false),
      onCommit: (cm) => {
        tabs.post({t: 'commit', seq: cm.seq, buckets: cm.buckets, cleared: cm.cleared, dropped: cm.dropped});
      },
      onError: (err) => {
        console.error('livesync: persisting failed', err);
      },
    });
    persister = p;
    void hydrated.then(() => {
      p.schedule(); // what waited for hydration
    });
    const c = new SyncClient({
      pool, meta, persister: p, userId, auth: opts.auth, clientId: tabs.id,
      ensureHydrated: (g) => hydrator.groups([g]),
      ...(opts.endpoint ? {endpoint: opts.endpoint} : {}),
      ...(opts.buildId ? {buildId: opts.buildId} : {}),
      ...(opts.transport ? {transport: opts.transport} : {}),
      ...(opts.env?.transport ? {env: opts.env.transport} : {}),
    });
    client = c;
    runInAction(() => {
      role.leader = true;
    });
    runPendingLocally();
    for (const name of ['revoked', 'issueDropped', 'newBuild', 'schemaMismatch', 'caughtUp', 'wrongUser', 'workspace'] as const) {
      cleanups.push(c.on(name, (e) => {
        emit(name, e as never);
        tabs.post({t: 'event', name, e});
      }));
    }
    cleanups.push(autorun(() => {
      const s = {...c.status};
      runInAction(() => Object.assign(status, s));
      tabs.post({t: 'status', status: s});
    }));
    for (const g of myHolds.keys()) c.hold(g, holder);
    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [tab, at] of tabSeen) {
        if (now - at < timeout) continue;
        tabSeen.delete(tab);
        tabHolds.delete(tab);
        c.releaseHolder(`tab:${tab}`);
      }
    }, HEARTBEAT);
    cleanups.push(() => {
      clearInterval(sweep);
    });
    const onHide = () => {
      c.persistPositions();
      void p.flush();
    };
    window.addEventListener('pagehide', onHide);
    cleanups.push(() => {
      window.removeEventListener('pagehide', onHide);
    });
    tabs.post({t: 'leader', tab: tabs.id});
    c.start();
  };

  tabs.post({t: 'hello', tab: tabs.id});
  const heartbeat = setInterval(() => {
    if (!role.leader) tabs.post({t: 'alive', tab: tabs.id, holds: [...myHolds.keys()]});
  }, HEARTBEAT);
  cleanups.push(() => {
    clearInterval(heartbeat);
  });
  tabs.elect(() => {
    void promote().catch((err: unknown) => {
      console.error('livesync: taking over as the leader failed', err);
    });
  });
  markOnce('dataOpen');

  const data: Data = {
    userId, pool, status, role, firstRoute, hydrated, workspace,
    async hydrate(groups) {
      await hydrator.groups(groups);
    },
    peek: <M extends ModelName>(m: M) => (peeked.get(m) ?? new Map()) as ReadonlyMap<number, ModelTypes[M]>,
    countIntents: () => request(db.transaction(INTENTS, 'readonly').objectStore(INTENTS).count()),
    hold(group) {
      myHolds.set(group, (myHolds.get(group) ?? 0) + 1);
      if (myHolds.get(group) !== 1) return;
      void hydrator.groups([group]);
      if (role.leader && client) client.hold(group, holder);
      else tabs.post({t: 'hold', tab: tabs.id, group, on: true});
    },
    release(group) {
      const n = myHolds.get(group);
      if (n === undefined) return;
      if (n > 1) {
        myHolds.set(group, n - 1);
        return;
      }
      myHolds.delete(group);
      if (role.leader && client) client.release(group, holder);
      else tabs.post({t: 'hold', tab: tabs.id, group, on: false});
    },
    pin(group, on) {
      void ask('pin', group, on);
    },
    barrier: () => ask<number>('barrier'),
    whenSynced(group, v) {
      if (role.leader && client) return client.whenAt(group, v);
      return ask<undefined>('synced', group, v).then(() => undefined);
    },
    loadClosedPage: (group, before, limit) => ask('closedPage', group, before, limit),
    on(name, fn) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, set = new Set());
      set.add(fn);
      return () => set.delete(fn);
    },
    async close() {
      if (closed) return;
      closed = true;
      hydrator.close();
      client?.stop();
      for (const c of cleanups) c();
      if (persister) {
        await persister.flush();
        persister.close();
      }
      tabs.close();
      db.close();
    },
  };
  return data;
}

/** The number of unsynced intents in a user's database (the database must exist). */
export async function pendingIntentCount(userId: number, factory?: IDBFactory): Promise<number> {
  const db = await openDatabase(userId, factory ? {factory} : {});
  try {
    return await request(db.transaction(INTENTS, 'readonly').objectStore(INTENTS).count());
  } finally {
    db.close();
  }
}

/** Signs this device out of a user's data: deletes the database and the DB marker. */
export async function deleteUserData(userId: number, factory?: IDBFactory): Promise<void> {
  forgetUser();
  await deleteDatabase(userId, factory);
}
