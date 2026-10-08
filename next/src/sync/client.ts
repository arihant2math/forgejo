// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The sync client (PLAN §5.3; protocol: services/livesync/protocol,
// messages.go and bootstrap.go). Runs in the leader tab only.
//
// Session: open a transport (WebSocket, or SSE + POST after the WebSocket
// failed to open twice), send `hello` with every held group that has a
// position (resume from it), apply `delta`s through the pool, track
// positions (GroupTable), and bootstrap the groups that have no position or
// need a re-bootstrap over HTTP, subscribing them from the watermark
// afterwards. Reconnects with exponential backoff and jitter; a refused token
// is refreshed through SyncAuth.
//
// Holding: a group is held while it is reachable from a root — a persistent
// holder (workspace, recent, pin) or a tab's hold — through the groups'
// refs (BootstrapEnd.refs: the profile, organization and owner groups a
// group's entities name). Groups that stop being held are unsubscribed and
// purged. On-demand groups (an issue, a repository outside the workspace)
// get a "recent" holder and stay available offline until the LRU drops them.

import {observable, runInAction} from 'mobx';
import type {MetaCache} from '../data/meta.ts';
import {canHold, clientSchemas, groupKind, isModel, MODEL_NAMES, type ModelName, STRUCTURE_KINDS} from '../data/models.ts';
import type {Persister} from '../data/persist.ts';
import type {Applied, Pool} from '../data/pool.ts';
import type {
  BootstrapRequiredMessage, ClientMessage, DeltaMessage, Grant, GroupRequest, Refusal, ServerMessage, WelcomeMessage, Workspace,
} from '../protocol/types.gen.ts';
import {ProtocolVersion} from '../protocol/types.gen.ts';
import {HttpError, load, type LoadResult} from './bootstrap.ts';
import {type GroupState, GroupTable} from './groups.ts';
import {sameUnits} from './replace.ts';
import {markOnce} from './rum.ts';
import {openSSE, openWebSocket, type Transport, type TransportEnv} from './transport.ts';

export interface SyncAuth {
  /** A current access token (OAuth2 or a personal access token). */
  token(): Promise<string>;
  /** The server refused the token: a new one, or null when signed out. */
  refresh(): Promise<string | null>;
}

export type Connection = 'idle' | 'connecting' | 'catching_up' | 'live' | 'offline' | 'unauthorized' | 'stopped';

export interface SyncStatus {
  connection: Connection;
  transport: 'ws' | 'sse' | undefined;
  /** Groups queued or being bootstrapped. */
  loading: number;
  /** Groups held. */
  groups: number;
  /** The server's position as last reported. */
  serverSyncId: number;
  lastError: string | undefined;
}

export interface SyncEvents {
  /** The viewer may no longer read a group; it was purged. */
  revoked: {group: string};
  /** An Issue was dropped (deleted, moved out of reach): its issue group was released. */
  issueDropped: {issueId: number};
  /** The server runs another build (notice new_build). */
  newBuild: Record<string, never>;
  /** The server's schema of these models differs from this build's: the app should update. */
  schemaMismatch: {models: string[]};
  /** Every subscribed group is live (caught_up). F5 flushes the offline queue on it. */
  caughtUp: {syncId: number};
  /** The session belongs to another user than this database. */
  wrongUser: {viewerId: number};
  /** GET /-/sync/workspace answered (every session): the groups the viewer's workspace is made of. */
  workspace: {workspace: Workspace};
}

type Listener<K extends keyof SyncEvents> = (e: SyncEvents[K]) => void;

export interface SyncClientOptions {
  pool: Pool;
  meta: MetaCache;
  persister: Pick<Persister, 'schedule' | 'flush' | 'clearModels' | 'dropGroups'>;
  /**
   * Resolves once everything IndexedDB holds of the group is in the pool.
   * The client runs before hydration finished; a replacement or reset must
   * see every held entity first.
   */
  ensureHydrated?: (group: string) => Promise<unknown>;
  userId: number;
  auth: SyncAuth;
  /** The sync endpoint path or URL (default "/-/sync"). */
  endpoint?: string;
  buildId?: string;
  clientId?: string;
  transport?: 'auto' | 'ws' | 'sse';
  env?: TransportEnv;
  /** Parallel bootstraps (default 4). */
  maxBootstraps?: number;
  /** How many on-demand groups of a kind stay held after use (default issue 300, repo 30). */
  recentCaps?: Partial<Record<'issue' | 'repo' | 'org' | 'profile' | 'owner' | 'user', number>>;
  /** Keep-alive: ping interval and how long to wait for the pong (ms). */
  pingInterval?: number;
  pongTimeout?: number;
  /** First reconnect delay (ms, default 500); doubles per attempt up to 30 s, with jitter. */
  backoffBase?: number;
  now?: () => number;
}

interface Sub {
  granted: boolean;
  caughtUp: boolean;
  /** The request (hello or subscribe) whose answer decides this subscription. */
  req: number;
}

interface Session {
  transport: Transport;
  welcomed: boolean;
  subs: Map<string, Sub>;
  barriers: Map<string, {resolve: (syncId: number) => void; reject: (err: Error) => void}>;
  ping: ReturnType<typeof setInterval> | undefined;
  pong: ReturnType<typeof setTimeout> | undefined;
  /** Groups the server refused for the subscription limit (retried when room frees up, or next session). */
  limited: Set<string>;
  everCaughtUp: boolean;
  /**
   * The hello and subscribes not answered yet, in order: the server answers
   * them in order (welcome, subscribed), so an answer belongs to the oldest.
   * A group's answer counts only if it answers the group's latest request —
   * not a request the group was unsubscribed and re-requested since.
   */
  pending: number[];
  reqSeq: number;
}

const RECENT = 'recent';
const MAX_BARRIERS = 16;
const WORKSPACE = 'workspace';

export class SyncClient {
  readonly status: SyncStatus = observable({
    connection: 'idle', transport: undefined, loading: 0, groups: 0, serverSyncId: 0, lastError: undefined,
  }, {}, {deep: false});

  private readonly o: Required<Pick<SyncClientOptions, 'endpoint' | 'maxBootstraps' | 'pingInterval' | 'pongTimeout'>> & SyncClientOptions;
  private readonly pool: Pool;
  readonly groups: GroupTable;
  private session: Session | undefined;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private transportKind: 'ws' | 'sse';
  private failedOpens = 0;
  /** Tab holds (not persisted): group → holders. */
  private readonly ephemeral = new Map<string, Set<string>>();
  private live = new Set<string>();
  private readonly queue = new Set<string>();
  private readonly running = new Map<string, AbortController>();
  private readonly retryAt = new Map<string, number>();
  private readonly retryCount = new Map<string, number>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Groups whose bootstrap failed permanently (400) this session. */
  private readonly failed = new Set<string>();
  private readonly listeners = new Map<keyof SyncEvents, Set<Listener<never>>>();
  private barrierSeq = 0;
  /** The server position last reported (status.serverSyncId follows it at most every second). */
  private serverPos = 0;
  private tick: ReturnType<typeof setInterval> | undefined;
  /** Loads of one group run one at a time (a bootstrap and a closed page must not overlap). */
  private readonly groupLocks = new Map<string, Promise<void>>();
  private workspaceOrder = new Map<string, number>();
  private readonly offPool: () => void;
  private readonly onOnline = () => {
    if (this.stopped) return;
    this.attempts = 0;
    if (!this.session) this.connect();
    this.pump();
  };
  private readonly onOffline = () => {
    this.setStatus({connection: 'offline'});
  };

  constructor(opts: SyncClientOptions) {
    this.o = {endpoint: '/-/sync', maxBootstraps: 4, pingInterval: 25_000, pongTimeout: 10_000, ...opts};
    this.pool = opts.pool;
    this.groups = new GroupTable(opts.meta);
    this.transportKind = opts.transport === 'sse' ? 'sse' : 'ws';
    const ws = opts.meta.get<Workspace>('workspace');
    if (ws) this.workspaceOrder = new Map(ws.groups.map((g, i) => [g.group, i]));
    this.offPool = this.pool.onApplied((changes) => {
      this.droppedIssues(changes);
    });
    this.recompute();
  }

  // ---- public API ----

  on<K extends keyof SyncEvents>(name: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, set = new Set());
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Starts syncing: connects and bootstraps what is missing. Call after hydration completed. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
    }
    this.applyStoredSchemas();
    // Positions and the status' server position are written at most every second (not per frame).
    this.tick = setInterval(() => {
      this.persistPositions();
      if (this.serverPos !== this.status.serverSyncId) this.setStatus({serverSyncId: this.serverPos});
    }, 1000);
    this.connect();
    this.pump();
  }

  /** Hands the positions raised since the last call to the persister (meta). */
  persistPositions(): void {
    if (this.groups.persistRaised()) this.o.persister.schedule();
  }

  /** Whether a load of the group is queued or running (its persistence waits for the end). */
  isLoading(group: string): boolean {
    return this.groupLocks.has(group);
  }

  /** Stops syncing (the tab stops being the leader, or signs out). */
  stop(): void {
    this.stopped = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
    }
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    if (this.tick !== undefined) clearInterval(this.tick);
    this.reconnectTimer = this.retryTimer = this.tick = undefined;
    this.persistPositions();
    for (const c of this.running.values()) c.abort();
    this.running.clear();
    this.queue.clear();
    this.endSession();
    this.offPool();
    this.setStatus({connection: 'stopped', loading: 0});
  }

  /** Whether a group is held (reachable from a root). */
  isHeld(group: string): boolean {
    return this.live.has(group);
  }

  /** The groups held. */
  held(): ReadonlySet<string> {
    return this.live;
  }

  /**
   * Holds a group for `holder` (a tab, a view). The group is loaded if needed
   * and kept live while held; on-demand groups also stay available offline
   * (LRU) after the hold is released.
   */
  hold(group: string, holder: string): void {
    if (!groupKind(group)) return;
    let set = this.ephemeral.get(group);
    if (!set) this.ephemeral.set(group, set = new Set());
    set.add(holder);
    const kind = groupKind(group);
    if (kind && kind !== 'profiles') {
      const s = this.groups.get(group);
      if (!s?.holders.includes(WORKSPACE)) {
        const now = this.now();
        this.groups.update(group, (x) => {
          if (!x.holders.includes(RECENT)) x.holders.push(RECENT);
          x.used = now;
        });
        this.trimRecent();
      }
    }
    this.recompute();
    this.o.persister.schedule();
  }

  release(group: string, holder: string): void {
    const set = this.ephemeral.get(group);
    if (!set?.delete(holder)) return;
    if (!set.size) this.ephemeral.delete(group);
    this.recompute();
    this.o.persister.schedule();
  }

  /** Drops every hold of a tab (it closed or stopped answering). */
  releaseHolder(holder: string): void {
    let changed = false;
    for (const [g, set] of this.ephemeral) {
      if (set.delete(holder)) changed = true;
      if (!set.size) this.ephemeral.delete(g);
    }
    if (changed) this.recompute();
  }

  /** Pins or unpins a group (kept offline, never dropped by the LRU). */
  pin(group: string, on: boolean): void {
    if (!groupKind(group)) return;
    this.setHolder(group, 'pin', on);
  }

  /**
   * Resolves with a sync id once everything committed to the server's log
   * before the call has been delivered for every subscribed group (barrier).
   */
  barrier(): Promise<number> {
    const s = this.session;
    if (!s?.welcomed) return Promise.reject(new Error('not connected'));
    // The server answers at most 16 pending barriers per session (error too_many_barriers, without an id).
    if (s.barriers.size >= MAX_BARRIERS) return Promise.reject(new Error('too many pending barriers'));
    const id = `b${++this.barrierSeq}`;
    return new Promise((resolve, reject) => {
      s.barriers.set(id, {resolve, reject});
      this.send({type: 'barrier', id});
    });
  }

  /**
   * Loads a page of a repository's older closed issues and pull requests
   * (the closed tier). Start with `before` = undefined (the summary's cutoff);
   * the result's `next` continues.
   */
  async loadClosedPage(group: string, before?: string, limit?: number): Promise<{next: string | undefined; count: number}> {
    const s = this.groups.get(group);
    if (groupKind(group) !== 'repo' || !s || !this.isHeld(group)) throw new Error(`${group} is not a held repository group`);
    const cursor = before ?? (s.closedBefore !== undefined ? String(s.closedBefore) : undefined);
    if (cursor === undefined) throw new Error(`${group} is not loaded yet`);
    const res = await this.exclusive(group, async () => {
      await this.o.ensureHydrated?.(group);
      return load(this.pool, {
        endpoint: this.o.endpoint, token: await this.o.auth.token(), group, kind: 'load', closedBefore: cursor, heldUnits: s.units,
        summaryClosedBefore: s.closedBefore, live: () => this.isHeld(group), ...(limit ? {limit} : {}),
        ...(this.o.env?.fetch ? {fetch: this.o.env.fetch} : {}),
      });
    });
    this.groups.update(group, (x) => {
      // The units rule; and the page's refs are held too (profiles named only by old closed issues).
      if (x.units !== undefined && !sameUnits(x.units, list(res.header.units))) x.needs = {all: true, models: [], reason: 'permission_changed'};
      const refs = list(res.end.refs).filter((r) => r !== group && groupKind(r) !== undefined);
      x.pageRefs = [...new Set([...x.pageRefs ?? [], ...refs])];
    });
    this.recompute();
    if (this.groups.get(group)?.needs) this.enqueue(group);
    this.o.persister.schedule();
    return {next: res.end.next, count: res.count};
  }

  // ---- session ----

  private connect(): void {
    if (this.stopped || this.session) return;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (offline()) {
      this.setStatus({connection: 'offline'});
      return; // the online event reconnects
    }
    this.setStatus({connection: 'connecting', transport: this.transportKind});
    const handlers = {
      open: () => {
        void this.opened(session);
      },
      message: (msg: ServerMessage) => {
        if (this.session === session) this.handle(session, msg);
      },
      close: (info: {opened: boolean; code?: number; reason?: string}) => {
        if (this.session !== session) return;
        this.closed(info);
      },
    };
    const open = this.transportKind === 'sse' ? openSSE : openWebSocket;
    const session: Session = {
      transport: undefined as unknown as Transport,
      welcomed: false, subs: new Map(), barriers: new Map(), ping: undefined, pong: undefined, limited: new Set(), everCaughtUp: false,
      pending: [], reqSeq: 0,
    };
    this.session = session;
    session.transport = open(this.o.endpoint, handlers, this.o.env);
  }

  private async opened(session: Session): Promise<void> {
    markOnce('wsOpen');
    this.failedOpens = 0;
    let token: string;
    try {
      token = await this.o.auth.token();
    } catch (err) {
      this.setStatus({lastError: String(err)});
      session.transport.close();
      return;
    }
    if (this.session !== session) return;
    const groups: GroupRequest[] = [];
    for (const g of this.live) {
      const s = this.groups.get(g);
      if (s?.position === undefined) continue;
      groups.push({group: g, since: s.position});
    }
    this.request(session, groups);
    const hello: ClientMessage = {type: 'hello', token, protocol: ProtocolVersion, groups};
    if (this.o.clientId) hello.client_id = this.o.clientId;
    if (this.o.buildId) hello.build_id = this.o.buildId;
    session.transport.send(hello);
  }

  private closed(info: {opened: boolean; code?: number; reason?: string}): void {
    this.endSession();
    if (this.stopped || this.status.connection === 'unauthorized') return;
    if (!info.opened && this.o.transport !== 'ws' && this.o.transport !== 'sse') {
      // The transport never opened: after two such failures try the other one.
      if (++this.failedOpens >= 2) {
        this.transportKind = this.transportKind === 'ws' ? 'sse' : 'ws';
        this.failedOpens = 0;
      }
    }
    this.scheduleReconnect();
  }

  private endSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    if (s.ping !== undefined) clearInterval(s.ping);
    if (s.pong !== undefined) clearTimeout(s.pong);
    for (const b of s.barriers.values()) b.reject(new Error('disconnected'));
    s.barriers.clear();
    s.transport.close();
    if (!this.stopped && this.status.connection !== 'unauthorized') {
      this.setStatus({connection: offline() ? 'offline' : 'connecting'});
    }
  }

  private scheduleReconnect(minDelay = 0): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const base = Math.min(30_000, (this.o.backoffBase ?? 500) * 2 ** this.attempts);
    this.attempts++;
    const delay = Math.max(minDelay, base * (0.5 + Math.random()));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private send(msg: ClientMessage): void {
    this.session?.transport.send(msg);
  }

  private handle(session: Session, msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        this.welcome(session, msg);
        break;
      case 'subscribed':
        this.granted(session, session.pending.shift(), msg.granted, msg.refused);
        break;
      case 'delta':
        this.delta(session, msg);
        break;
      case 'caught_up':
        this.caughtUp(session, msg.sync_id);
        break;
      case 'bootstrap_required':
        this.bootstrapRequired(msg);
        break;
      case 'group_revoked':
        session.subs.delete(msg.group);
        this.revoke(msg.group);
        break;
      case 'barrier_ok': {
        this.raiseCaughtUp(session, msg.sync_id);
        const b = session.barriers.get(msg.id);
        session.barriers.delete(msg.id);
        b?.resolve(msg.sync_id);
        break;
      }
      case 'pong':
        if (session.pong !== undefined) clearTimeout(session.pong);
        session.pong = undefined;
        this.raiseCaughtUp(session, msg.sync_id);
        break;
      case 'grants':
        this.o.meta.set('grants', msg.grants);
        void this.refreshWorkspace();
        break;
      case 'session_invalid':
        void this.invalidToken();
        break;
      case 'notice':
        if (msg.kind === 'new_build') this.emit('newBuild', {});
        else {
          // shutdown: reconnect (another instance, or this one once it is back).
          this.endSession();
          this.scheduleReconnect(1000);
        }
        break;
      case 'resume_from_cursor':
        this.raiseCaughtUp(session, msg.sync_id);
        this.endSession();
        this.scheduleReconnect();
        break;
      case 'error':
        this.setStatus({lastError: `${msg.code}: ${msg.message}`});
        if (msg.code === 'too_many_connections') {
          this.endSession();
          this.scheduleReconnect(30_000);
        } else if (msg.code === 'too_many_barriers') {
          // The last barrier sent was refused (the error names none).
          const last = [...session.barriers.keys()].at(-1);
          if (last !== undefined) {
            session.barriers.get(last)?.reject(new Error('too many barriers'));
            session.barriers.delete(last);
          }
        } else if (msg.code !== 'bad_message') {
          console.error('livesync:', msg.code, msg.message);
        }
        break;
      case 'session':
        break;
    }
    this.o.persister.schedule();
  }

  private welcome(session: Session, msg: WelcomeMessage): void {
    if (msg.viewer_id !== this.o.userId) {
      this.emit('wrongUser', {viewerId: msg.viewer_id});
      this.stop();
      return;
    }
    session.welcomed = true;
    // Every persisted version is at most the server's position: purges from now on cover what hydration has not read yet.
    this.pool.noteVersion(msg.server_sync_id);
    this.serverPos = Math.max(this.serverPos, msg.server_sync_id);
    const protocolOK = msg.protocol === ProtocolVersion;
    this.setStatus({serverSyncId: this.serverPos, lastError: protocolOK ? undefined : `server protocol ${msg.protocol}, client ${ProtocolVersion}`});
    if (!protocolOK) this.emit('newBuild', {});
    this.checkServerSchemas(msg.schemas, true);
    if (msg.profile && isModel(msg.profile.m)) {
      const p = msg.profile;
      this.pool.batch(() => this.pool.put(p.m as ModelName, p.id, p.g, p.v, p.d as never));
    }
    this.granted(session, session.pending.shift(), msg.granted, msg.refused);
    this.o.meta.set('grants', msg.grants);
    // Every session: the workspace may have changed while the client was away (cheap, one request).
    void this.refreshWorkspace();
    // Groups without a position are bootstrapped first, then subscribed; groups that got a position
    // after the hello was sent (a bootstrap finished meanwhile) are subscribed now.
    const late: GroupRequest[] = [];
    for (const g of this.live) {
      const s = this.groups.get(g);
      if (s?.position === undefined || s.needs) this.enqueue(g);
      if (s?.position !== undefined && !session.subs.has(g) && !session.limited.has(g)) late.push({group: g, since: s.position});
    }
    this.subscribe(session, late);
    session.ping = setInterval(() => {
      if (this.session !== session) return;
      this.send({type: 'ping', id: 'k'});
      session.pong ??= setTimeout(() => {
        if (this.session === session) session.transport.close();
      }, this.o.pongTimeout);
    }, this.o.pingInterval);
    this.updateConnection(session);
    this.pump();
  }

  /** Registers subscriptions requested by the next hello or subscribe (sent by the caller). */
  private request(session: Session, groups: readonly GroupRequest[]): void {
    const req = ++session.reqSeq;
    session.pending.push(req);
    for (const g of groups) session.subs.set(g.group, {granted: false, caughtUp: false, req});
  }

  private subscribe(session: Session, groups: GroupRequest[]): void {
    if (!groups.length) return;
    this.request(session, groups);
    this.send({type: 'subscribe', groups});
    this.updateConnection(session);
  }

  private granted(session: Session, req: number | undefined, granted: Grant[] | null, refused: Refusal[] | null): void {
    // Answers for a request the group no longer waits on (it was unsubscribed — the server
    // processed that after this answer — and maybe requested again) are ignored.
    const current = (g: string) => {
      const sub = session.subs.get(g);
      return sub !== undefined && sub.req === req ? sub : undefined;
    };
    for (const gr of list(granted)) {
      const sub = current(gr.group);
      if (!sub) continue;
      sub.granted = true;
      sub.caughtUp = false;
      session.limited.delete(gr.group);
      const s = this.groups.get(gr.group);
      // The units rule: a grant with other units than the held entities were filtered by.
      if (s?.units !== undefined && !sameUnits(s.units, list(gr.units))) {
        this.groups.need(gr.group, undefined, 'permission_changed');
        this.enqueue(gr.group);
      }
    }
    for (const r of list(refused)) {
      if (!current(r.group)) continue;
      session.subs.delete(r.group);
      if (r.reason === 'limit') {
        session.limited.add(r.group);
        this.setStatus({lastError: `subscription limit reached (${r.group})`});
      } else {
        this.revoke(r.group);
      }
    }
    this.updateConnection(session);
  }

  private delta(session: Session, msg: DeltaMessage): void {
    const top = new Map<string, number>();
    const viewer = this.o.userId;
    this.pool.batch(() => {
      for (const c of list(msg.changes)) {
        const own = c.m === 'User' && c.id === viewer;
        if (!own && !session.subs.get(c.g)?.granted) continue; // unsubscribed meanwhile
        if (!isModel(c.m)) continue;
        if (c.op === 'U') this.pool.put(c.m, c.id, c.g, c.v, c.d as never);
        else if (c.op === 'D') this.pool.del(c.m, c.id, c.g, c.v);
        // The viewer's own profile may come outside its group's subscription (B5): it raises no position.
        if (!own && (top.get(c.g) ?? 0) < c.v) top.set(c.g, c.v);
      }
    });
    for (const [g, v] of top) this.groups.raise(g, v);
    this.raiseCaughtUp(session, msg.to);
  }

  private raiseCaughtUp(session: Session, pos: number): void {
    if (pos > this.serverPos) this.serverPos = pos;
    for (const [g, sub] of session.subs) {
      if (sub.granted && sub.caughtUp) this.groups.raise(g, pos);
    }
  }

  private caughtUp(session: Session, syncId: number): void {
    for (const sub of session.subs.values()) {
      if (sub.granted) sub.caughtUp = true;
    }
    this.raiseCaughtUp(session, syncId);
    if (!session.everCaughtUp) {
      session.everCaughtUp = true;
      this.attempts = 0;
    }
    markOnce('caughtUp');
    this.updateConnection(session);
    this.emit('caughtUp', {syncId});
  }

  private updateConnection(session: Session): void {
    if (this.session !== session || !session.welcomed) return;
    let waiting = false;
    for (const sub of session.subs.values()) {
      if (!sub.caughtUp) waiting = true;
    }
    this.setStatus({connection: waiting ? 'catching_up' : 'live'});
  }

  private bootstrapRequired(msg: BootstrapRequiredMessage): void {
    if (!this.live.has(msg.group)) return;
    if (msg.model && !isModel(msg.model)) return; // a model this build does not hold
    if (msg.reason === 'cursor_unknown') {
      void this.resetGroup(msg.group);
      return;
    }
    this.groups.need(msg.group, msg.model === undefined || msg.model === '' ? undefined : msg.model, msg.reason);
    this.enqueue(msg.group);
  }

  /**
   * cursor_unknown: the group's position is ahead of the server's log (another
   * database, e.g. restored from a backup): what is held of it carries versions
   * that would win every version check. Forget it and load it again.
   */
  private async resetGroup(group: string): Promise<void> {
    await this.exclusive(group, async () => {
      await this.o.ensureHydrated?.(group);
      if (!this.live.has(group)) return;
      this.pool.batch(() => this.pool.resetGroup(group));
      this.o.persister.dropGroups([group]);
      this.groups.update(group, (x) => {
        delete x.position;
        delete x.units;
        delete x.watermark;
        delete x.closedBefore;
        x.needs = {all: true, models: [], reason: 'cursor_unknown'};
      });
    });
    this.enqueue(group);
  }

  private async invalidToken(): Promise<void> {
    this.endSession();
    let token: string | null;
    try {
      token = await this.o.auth.refresh();
    } catch (err) {
      this.setStatus({lastError: String(err)});
      this.scheduleReconnect();
      return;
    }
    if (token === null) {
      this.setStatus({connection: 'unauthorized'});
      return;
    }
    this.scheduleReconnect();
  }

  // ---- schemas ----

  /** Stored data of another schema than this build's is dropped and re-bootstrapped. */
  private applyStoredSchemas(): void {
    const stored = this.o.meta.get<Record<string, number>>('schemas') ?? {};
    const server = this.o.meta.get<Record<string, number>>('serverSchemas') ?? {};
    const client = clientSchemas();
    const fresh = Object.keys(stored).length === 0;
    const drop = new Set<ModelName>();
    const next: Record<string, number> = {...stored};
    for (const m of MODEL_NAMES) {
      if (stored[m] === undefined) {
        // A model this build adds: older builds skipped its entities while positions moved on.
        if (!fresh) drop.add(m);
        next[m] = client[m];
      } else if (stored[m] !== client[m] && server[m] !== stored[m]) {
        // Stored data of another version than this build's — unless the server itself still sends
        // that version (then this build is the odd one: schemaMismatch, F5 updates the app).
        drop.add(m);
        next[m] = client[m];
      }
    }
    for (const m of this.o.meta.get<string[]>('droppedModels') ?? []) if (isModel(m)) drop.add(m);
    if (this.o.meta.get('droppedModels') !== undefined) this.o.meta.delete('droppedModels');
    this.dropModels(drop, 'schema_changed');
    this.o.meta.set('schemas', next);
  }

  private checkServerSchemas(server: Record<string, number> | null, report: boolean): void {
    if (!server) return;
    this.o.meta.set('serverSchemas', {...this.o.meta.get<Record<string, number>>('serverSchemas') ?? {}, ...server});
    const stored = {...this.o.meta.get<Record<string, number>>('schemas') ?? {}};
    const client = clientSchemas();
    const drop = new Set<ModelName>();
    const mismatch: string[] = [];
    for (const m of MODEL_NAMES) {
      const sv = server[m];
      if (sv === undefined) continue;
      if (sv !== client[m]) mismatch.push(m);
      if (stored[m] !== sv) {
        if (stored[m] !== undefined) drop.add(m);
        stored[m] = sv;
      }
    }
    this.o.meta.set('schemas', stored);
    this.dropModels(drop, 'schema_changed');
    if (report && mismatch.length) this.emit('schemaMismatch', {models: mismatch});
  }

  private dropModels(models: ReadonlySet<ModelName>, reason: string): void {
    if (!models.size) return;
    for (const m of models) this.pool.clearModel(m);
    this.o.persister.clearModels([...models]);
    for (const s of [...this.groups.all()]) {
      const kind = groupKind(s.group);
      if (!kind || s.position === undefined) continue;
      for (const m of models) {
        if (canHold(kind, m)) this.groups.need(s.group, m, reason);
      }
      if (this.groups.get(s.group)?.needs) this.enqueue(s.group);
    }
  }

  // ---- holding ----

  private setHolder(group: string, holder: string, on: boolean): void {
    const s = this.groups.get(group);
    if (on === Boolean(s?.holders.includes(holder))) return;
    if (!on && !s) return;
    this.groups.update(group, (x) => {
      x.holders = on ? [...x.holders, holder] : x.holders.filter((h) => h !== holder);
    });
    this.recompute();
    this.o.persister.schedule();
  }

  /** Recomputes the held set (roots + refs) and loads / releases the difference. */
  private recompute(): void {
    const stack: string[] = [];
    for (const s of this.groups.all()) if (s.holders.length) stack.push(s.group);
    for (const g of this.ephemeral.keys()) stack.push(g);
    const next = new Set<string>();
    while (stack.length) {
      const g = stack.pop();
      if (g === undefined || next.has(g)) continue;
      next.add(g);
      const st = this.groups.get(g);
      for (const r of st?.refs ?? []) stack.push(r);
      for (const r of st?.pageRefs ?? []) stack.push(r);
    }
    const prev = this.live;
    this.live = next;
    for (const g of prev) if (!next.has(g)) this.releaseGroup(g);
    for (const g of next) if (!prev.has(g)) this.newlyHeld(g);
    // States of groups that are no longer reachable and hold nothing.
    for (const s of [...this.groups.all()]) {
      if (!next.has(s.group) && !s.holders.length) this.groups.remove(s.group);
    }
    this.setStatus({groups: next.size});
  }

  private newlyHeld(group: string): void {
    if (!this.groups.get(group)) this.groups.update(group, () => undefined);
    const s = this.groups.get(group);
    const session = this.session;
    if (s?.position !== undefined && session?.welcomed && !session.subs.has(group)) this.subscribe(session, [{group, since: s.position}]);
    if (s?.position === undefined || s.needs) this.enqueue(group);
  }

  private releaseGroup(group: string): void {
    this.running.get(group)?.abort();
    this.running.delete(group);
    this.queue.delete(group);
    const session = this.session;
    if (session?.subs.delete(group)) {
      this.send({type: 'unsubscribe', groups: [group]});
      this.updateConnection(session);
    }
    this.pool.batch(() => this.pool.purgeGroup(group));
    this.o.persister.dropGroups([group]);
    this.groups.remove(group);
    this.o.persister.schedule();
    // Room under the subscription limit: retry a refused group.
    const retry = session?.welcomed ? [...session.limited].find((g) => this.live.has(g)) : undefined;
    const pos = retry === undefined ? undefined : this.groups.get(retry)?.position;
    if (session && retry !== undefined && pos !== undefined) {
      session.limited.delete(retry);
      this.subscribe(session, [{group: retry, since: pos}]);
    }
  }

  /** The viewer may not read the group (any more): purge it and drop every hold on it. */
  private revoke(group: string): void {
    this.ephemeral.delete(group);
    for (const st of [...this.groups.all()]) {
      if (st.group === group && st.holders.length) {
        this.groups.update(group, (x) => {
          x.holders = [];
        });
      }
      // Groups that refer to it stop holding it; their next bootstrap lists it again if it is readable again.
      if (st.refs?.includes(group) || st.pageRefs?.includes(group)) {
        this.groups.update(st.group, (x) => {
          x.refs = (x.refs ?? []).filter((r) => r !== group);
          if (x.pageRefs) x.pageRefs = x.pageRefs.filter((r) => r !== group);
        });
      }
    }
    this.recompute(); // releases it if it was held
    this.pool.batch(() => this.pool.purgeGroup(group));
    this.o.persister.dropGroups([group]);
    this.groups.remove(group);
    this.o.persister.schedule();
    this.emit('revoked', {group});
  }

  private trimRecent(): void {
    const caps = {issue: 300, repo: 30, org: 50, profile: 50, owner: 50, user: 5, ...this.o.recentCaps};
    const byKind = new Map<string, GroupState[]>();
    for (const s of this.groups.all()) {
      if (!s.holders.includes(RECENT)) continue;
      const kind = groupKind(s.group) ?? '';
      let l = byKind.get(kind);
      if (!l) byKind.set(kind, l = []);
      l.push(s);
    }
    for (const [kind, list] of byKind) {
      const cap = (caps as Record<string, number | undefined>)[kind] ?? 50;
      if (list.length <= cap) continue;
      list.sort((a, b) => (a.used ?? 0) - (b.used ?? 0));
      let excess = list.length - cap;
      for (const s of list) {
        if (excess <= 0) break;
        if (this.ephemeral.has(s.group)) continue;
        this.groups.update(s.group, (x) => {
          x.holders = x.holders.filter((h) => h !== RECENT);
        });
        excess--;
      }
    }
  }

  private droppedIssues(changes: readonly Applied[]): void {
    if (this.stopped) return;
    for (const c of changes) {
      if (c.model !== 'Issue' || c.entity || !c.dropped) continue;
      const g = `issue:${c.id}`;
      if (!this.groups.get(g) && !this.ephemeral.has(g)) continue;
      if (this.pool.model('Issue').get(c.id)) continue; // moved, not gone
      this.ephemeral.delete(g);
      this.groups.update(g, (x) => {
        x.holders = [];
      });
      this.recompute();
      this.emit('issueDropped', {issueId: c.id});
    }
  }

  private async refreshWorkspace(): Promise<void> {
    let ws: Workspace;
    try {
      const token = await this.o.auth.token();
      const f = this.o.env?.fetch ?? fetch;
      const res = await f(`${this.o.endpoint}/workspace`, {headers: {Authorization: `Bearer ${token}`}, cache: 'no-store'});
      if (!res.ok) throw new HttpError(res.status, res.statusText);
      ws = await res.json() as Workspace;
    } catch (err) {
      this.setStatus({lastError: `workspace: ${String(err)}`});
      return;
    }
    if (this.stopped || ws.viewer_id !== this.o.userId) return;
    this.o.meta.set('workspace', ws);
    this.workspaceOrder = new Map(ws.groups.map((g, i) => [g.group, i]));
    const want = new Set(ws.groups.map((g) => g.group).filter((g) => groupKind(g) !== undefined));
    for (const s of [...this.groups.all()]) {
      if (s.holders.includes(WORKSPACE) && !want.has(s.group)) {
        this.groups.update(s.group, (x) => {
          x.holders = x.holders.filter((h) => h !== WORKSPACE);
        });
      }
    }
    for (const g of want) {
      const s = this.groups.get(g);
      if (s?.holders.includes(WORKSPACE)) continue;
      this.groups.update(g, (x) => {
        x.holders = [...x.holders.filter((h) => h !== RECENT), WORKSPACE];
      });
    }
    this.recompute();
    this.o.persister.schedule();
    this.emit('workspace', {workspace: ws});
  }

  // ---- bootstraps ----

  private enqueue(group: string): void {
    if (this.failed.has(group)) return;
    this.queue.add(group);
    this.pump();
  }

  private priority(group: string): number {
    if (this.ephemeral.has(group)) return 0;
    const kind = groupKind(group);
    if (kind && STRUCTURE_KINDS.includes(kind)) return 1;
    if (kind === 'repo') return 2 + (this.workspaceOrder.get(group) ?? 10_000) / 100_000;
    return 3;
  }

  private pump(): void {
    if (this.stopped) return;
    if (offline()) return;
    const now = this.now();
    let nextRetry = Number.POSITIVE_INFINITY;
    while (this.running.size < this.o.maxBootstraps) {
      let best: string | undefined;
      let bestP = Number.POSITIVE_INFINITY;
      for (const g of this.queue) {
        if (this.running.has(g)) continue;
        const at = this.retryAt.get(g) ?? 0;
        if (at > now) {
          nextRetry = Math.min(nextRetry, at);
          continue;
        }
        const p = this.priority(g);
        if (p < bestP) {
          best = g;
          bestP = p;
        }
      }
      if (best === undefined) break;
      this.queue.delete(best);
      void this.bootstrap(best);
    }
    if (nextRetry !== Number.POSITIVE_INFINITY && this.retryTimer === undefined) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.pump();
      }, Math.max(0, nextRetry - now));
    }
    this.setStatus({loading: this.queue.size + this.running.size});
  }

  private async bootstrap(group: string): Promise<void> {
    if (!this.groups.get(group) || !this.live.has(group)) return;
    const ctrl = new AbortController();
    this.running.set(group, ctrl);
    this.setStatus({loading: this.queue.size + this.running.size});
    let err: unknown;
    let ok = false;
    try {
      // The group's state is read inside the group's lock: a reset or closed page queued ahead changes it.
      ok = await this.exclusive(group, async () => {
        await this.o.ensureHydrated?.(group);
        const st = this.groups.get(group);
        if (!st || ctrl.signal.aborted || !this.live.has(group)) return false;
        const needs = st.needs;
        // A model re-bootstrap needs a full one underneath it.
        const models = needs && !needs.all && st.watermark !== undefined ? needs.models : undefined;
        const res = await load(this.pool, {
          endpoint: this.o.endpoint, token: await this.o.auth.token(), group, models, signal: ctrl.signal,
          heldUnits: st.units, kind: groupKind(group) === 'issue' ? 'load' : 'bootstrap',
          live: () => !ctrl.signal.aborted && this.live.has(group),
          ...(this.o.env?.fetch ? {fetch: this.o.env.fetch} : {}),
        });
        if (this.isStopped() || !this.live.has(group)) return false; // aborted: released or stopped
        this.loaded(group, res, needs, models);
        return true;
      });
    } catch (e) {
      err = e;
    }
    if (this.running.get(group) === ctrl) this.running.delete(group);
    if (ctrl.signal.aborted || this.stopped || !this.live.has(group)) {
      this.pump();
      return;
    }
    if (!ok && err !== undefined) await this.loadFailed(group, err);
    this.o.persister.schedule();
    this.pump();
  }

  private loaded(group: string, res: LoadResult, needs: GroupState['needs'], models: string[] | undefined): void {
    const {header, end} = res;
    const w = header.watermark;
    this.retryAt.delete(group);
    this.retryCount.delete(group);
    const st = this.groups.update(group, (x) => {
      const unitsChanged = x.units !== undefined && !sameUnits(x.units, list(header.units));
      if (models) {
        x.position ??= w;
      } else {
        x.watermark = w;
        x.tier = header.tier;
        if (header.closed_before !== undefined) x.closedBefore = header.closed_before;
        else delete x.closedBefore;
        x.position = Math.max(x.position ?? 0, w);
      }
      if (x.needs === needs) {
        delete x.needs;
      }
      // A model re-bootstrap with other units: keep the old units, so the full bootstrap it needs
      // replaces the whole group (the units rule's scope).
      if (models && unitsChanged) x.needs = {all: true, models: [], reason: 'permission_changed'};
      else x.units = [...list(header.units)];
      if (!models) x.refs = list(end.refs).filter((r) => r !== group && groupKind(r) !== undefined);
    });
    this.checkServerSchemas(header.schemas, false);
    this.recompute();
    const session = this.session;
    if (session?.welcomed && !session.subs.has(group) && !session.limited.has(group) && st.position !== undefined) {
      this.subscribe(session, [{group, since: st.position}]);
    }
    if (st.needs) this.enqueue(group);
  }

  private async loadFailed(group: string, err: unknown): Promise<void> {
    const n = (this.retryCount.get(group) ?? 0) + 1;
    this.retryCount.set(group, n);
    let delay = Math.min(60_000, 1000 * 2 ** (n - 1)) * (0.5 + Math.random());
    if (err instanceof HttpError) {
      switch (err.status) {
        case 404:
          this.revoke(group);
          return;
        case 400:
        case 403:
          console.error(`livesync: bootstrap of ${group}:`, err.message);
          this.failed.add(group);
          return;
        case 401:
          try {
            if (await this.o.auth.refresh() === null) {
              this.setStatus({connection: 'unauthorized'});
              return;
            }
          } catch {
            // Retry later.
          }
          break;
        case 503:
          delay = (err.retryAfter ?? 2) * 1000;
          break;
      }
    }
    this.setStatus({lastError: `bootstrap ${group}: ${String(err)}`});
    this.retryAt.set(group, this.now() + delay);
    this.queue.add(group);
  }

  // ---- helpers ----

  private exclusive<T>(group: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.groupLocks.get(group) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.groupLocks.set(group, tail);
    void tail.then(() => {
      if (this.groupLocks.get(group) === tail) {
        this.groupLocks.delete(group);
        this.o.persister.schedule(); // its writes were deferred while it loaded
      }
    });
    return run;
  }

  /** A method: TypeScript would narrow a read of the field across awaits. */
  private isStopped(): boolean {
    return this.stopped;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    runInAction(() => {
      Object.assign(this.status, patch);
    });
  }

  private emit<K extends keyof SyncEvents>(name: K, e: SyncEvents[K]): void {
    for (const fn of this.listeners.get(name) ?? []) (fn as Listener<K>)(e);
  }
}

/** A list from the wire: Go encodes an empty (nil) slice as null. */
function list<T>(x: readonly T[] | null | undefined): readonly T[] {
  return x ?? [];
}

/** The browser says it is offline (an unknown state counts as online). */
function offline(): boolean {
  const nav = (globalThis as {navigator?: {onLine?: boolean}}).navigator;
  return nav?.onLine === false;
}
