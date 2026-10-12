// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Hydrate structure/route groups first and remaining state when idle.
// The elected leader syncs and persists; followers mirror what its flushes changed and forward requests.

import {autorun, observable, runInAction} from 'mobx';
import {forgetUser, writeSplash} from '../app/splash.ts';
import {type HydrateStats, Hydrator} from '../data/hydrate.ts';
import {deleteDatabase, DRAFTS, INTENTS, openDatabase, readMeta, request} from '../data/idb.ts';
import {MetaCache} from '../data/meta.ts';
import {groupKind, type ModelName, type ModelTypes, STRUCTURE_KINDS} from '../data/models.ts';
import type {Persister} from '../data/persist.ts';
import {Pool} from '../data/pool.ts';
import type {LogClosedMessage, LogMessage, Workspace} from '../protocol/types.gen.ts';
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
  /** Models peeked at for the first route (default Repository: sidebar and route lookups by name). */
  peekModels?: readonly ModelName[];
  /** Ask the browser not to evict the database (default true). */
  persistStorage?: boolean;
  env?: TabsEnv & {indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange; transport?: TransportEnv};
  /** Leadership has been relinquished after module-load failure; the app should reload. */
  onFatal?: (err: unknown) => void;
  /** Tab holds of tabs not heard from for this long are dropped (ms, default 60 s). */
  tabTimeout?: number;
}

export interface Data {
  readonly userId: number;
  readonly pool: Pool;
  readonly db: IDBDatabase;
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
  /** Counts queued intents and failed drafts. */
  countIntents(): Promise<number>;
  /** Non-observable first-route snapshot; prefer pool entities. Cleared after full hydration. */
  peek<M extends ModelName>(m: M): ReadonlyMap<number, ModelTypes[M]>;
  /** This tab shows a group: load it (if needed) and keep it live. */
  hold(group: string): void;
  release(group: string): void;
  pin(group: string, on: boolean): void;
  barrier(): Promise<number>;
  retry(): void;
  /** Resolves when this tab holds entries through v (followers: persisted and mirrored); rejects when signal aborts. */
  whenSynced(group: string, v: number, signal?: AbortSignal): Promise<void>;
  loadClosedPage(group: string, before?: string, limit?: number): Promise<{next: string | undefined; count: number}>;
  /** Delivers repeated job log messages; from resumes task lines. Returns an untail callback. */
  tailLog(jobId: number, from: {taskId: number; offset: number} | undefined, fn: (msg: LogMessage | LogClosedMessage) => void): () => void;
  on<K extends keyof SyncEvents>(name: K, fn: (e: SyncEvents[K]) => void): () => void;
  /** Flushes and stops (the tab gives up leadership). */
  close(): Promise<void>;
}

const HEARTBEAT = 20_000;

/** Load leader-only modules alongside route hydration to keep them off the first-frame bundle. */
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
      void data.close();
    },
  });
  writeSplash({user: String(userId)});
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
    if (JSON.stringify(e.workspace) === JSON.stringify(workspace.current)) return;
    runInAction(() => {
      workspace.current = e.workspace;
    });
  }]));

  const emit = <K extends keyof SyncEvents>(name: K, e: SyncEvents[K]) => {
    // Snapshot listeners so subscriptions added during dispatch cannot receive this event.
    for (const fn of [...listeners.get(name) ?? []]) (fn as (e: SyncEvents[K]) => void)(e);
  };
  const myHolds = new Map<string, number>();
  const holder = `tab:${tabs.id}`;
  /** Reissue this tab’s tails after leader changes; listeners deduplicate repeated lines. */
  const myTails = new Set<number>();
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
      for (const w of c.changes) pool.mirrorChanges(w.m, w.g, w.r, w.gone, c.seq);
    });
  };

  const tabSeen = new Map<string, number>();
  const tabHolds = new Map<string, Set<string>>();
  const timeout = opts.tabTimeout ?? 3 * HEARTBEAT;

  // Reissue idempotent requests to a new leader, or run locally on takeover.
  interface Pending {
    op: string;
    args: unknown[];
    signal: AbortSignal | undefined;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }
  const requests = new Map<number, Pending>();
  let reqSeq = 0;
  const ask = <T>(op: string, args: unknown[], signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    if (client) return local(op, args, signal) as Promise<T>;
    const id = ++reqSeq;
    return new Promise<T>((resolve, reject) => {
      requests.set(id, {op, args, signal, resolve: resolve as (v: unknown) => void, reject});
      signal?.addEventListener('abort', () => {
        // The leader's answer, if any, then finds no request.
        if (requests.delete(id)) reject(new Error('aborted'));
      }, {once: true});
      tabs.post({t: 'req', tab: tabs.id, id, op, args});
    });
  };
  const runPendingLocally = () => {
    for (const r of requests.values()) local(r.op, r.args, r.signal).then(r.resolve, r.reject);
    requests.clear();
  };
  const local = (op: string, args: unknown[], signal?: AbortSignal): Promise<unknown> => {
    if (!client) return Promise.reject(new Error('not the leader'));
    switch (op) {
      case 'barrier':
        return client.barrier();
      case 'closedPage':
        return client.loadClosedPage(args[0] as string, args[1] as string | undefined, args[2] as number | undefined);
      case 'pin':
        client.pin(args[0] as string, args[1] as boolean);
        return Promise.resolve();
      case 'retry':
        client.retryNow();
        return Promise.resolve();
      case 'log':
        // [job, holder, from | undefined | null (untail)]
        if (args[2] === null) client.untailLog(args[0] as number, args[1] as string);
        else client.tailLog(args[0] as number, args[1] as string, args[2] as {taskId: number; offset: number} | undefined);
        return Promise.resolve();
      case 'synced': {
        // Reply only after group loads and persistence finish, so the follower can mirror state through v.
        const c = client;
        const p = persister;
        const g = args[0] as string;
        const deadline = AbortSignal.timeout(60_000);
        return (async () => {
          await c.whenAt(g, args[1] as number, signal ? AbortSignal.any([deadline, signal]) : deadline);
          await c.loadsDone(g);
          await p?.flush();
        })();
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
          for (const job of myTails) void ask('log', [job, holder, undefined]);
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
      // Re-read IndexedDB before takeover to recover missed flush announcements.
      await hydrated;
      await hydrator.rereadAll();
      pool.batch(() => {
        pool.retainSeen(hydrator.seen, hydrator.oldestSeq);
      });
    } else {
      // Start after route hydration; defer writes of other groups until their hydration completes.
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
        tabs.post({t: 'commit', seq: cm.seq, changes: cm.changes, cleared: cm.cleared, dropped: cm.dropped});
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
    for (const name of ['revoked', 'issueDropped', 'newBuild', 'schemaMismatch', 'caughtUp', 'wrongUser', 'workspace', 'log'] as const) {
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
    for (const job of myTails) c.tailLog(job, holder);
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
    userId, pool, db, status, role, firstRoute, hydrated, workspace,
    async hydrate(groups) {
      await hydrator.groups(groups);
    },
    peek: <M extends ModelName>(m: M) => (peeked.get(m) ?? new Map()) as ReadonlyMap<number, ModelTypes[M]>,
    countIntents: () => unsynced(db),
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
      void ask('pin', [group, on]);
    },
    barrier: () => ask<number>('barrier', []),
    retry: () => {
      void ask('retry', []).catch(() => undefined);
    },
    whenSynced(group, v, signal) {
      if (role.leader && client) return client.whenAt(group, v, signal);
      return ask<undefined>('synced', [group, v], signal).then(() => undefined);
    },
    loadClosedPage: (group, before, limit) => ask('closedPage', [group, before, limit]),
    tailLog(jobId, from, fn) {
      const off = data.on('log', ({msg}) => {
        if (msg.job_id === jobId) fn(msg);
      });
      myTails.add(jobId);
      void ask('log', [jobId, holder, from]);
      return () => {
        off();
        myTails.delete(jobId);
        void ask('log', [jobId, holder, null]);
      };
    },
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

/** Waits until this tab holds a write's sync id `v` in every group, for at most `ms`; never rejects. */
export async function settleWrite(data: Pick<Data, 'whenSynced'>, groups: string | readonly string[], v: number | undefined, ms = 5000): Promise<void> {
  if (!v) return;
  const signal = AbortSignal.timeout(ms);
  await Promise.all((typeof groups === 'string' ? [groups] : groups).map((g) => data.whenSynced(g, v, signal).catch(() => undefined)));
}

async function unsynced(db: IDBDatabase): Promise<number> {
  const tx = db.transaction([INTENTS, DRAFTS], 'readonly');
  const [n, kinds] = await Promise.all([
    request(tx.objectStore(INTENTS).count()),
    request(tx.objectStore(DRAFTS).getAll() as IDBRequest<{kind?: string}[]>),
  ]);
  return n + kinds.filter((d) => d.kind === 'failed').length;
}

/** The number of unsynced changes in a user's database (the database must exist). */
export async function pendingIntentCount(userId: number, factory?: IDBFactory): Promise<number> {
  const db = await openDatabase(userId, factory ? {factory} : {});
  try {
    return await unsynced(db);
  } finally {
    db.close();
  }
}

/** Signs this device out of a user's data: deletes the database and the DB marker. */
export async function deleteUserData(userId: number, factory?: IDBFactory): Promise<void> {
  forgetUser();
  await deleteDatabase(userId, factory);
}
