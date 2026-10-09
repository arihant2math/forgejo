// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A raw sync protocol client (B5): the Next app's own transports
// (src/sync/transport.ts: WebSocket, or SSE + POST) carry the messages, but
// everything above them — hello, subscriptions, positions — is done here,
// message by message, so that the scenarios assert the server's wire
// behaviour and not the app's interpretation of it. Every message received
// is kept (`messages`) and checked against the invariants every message must
// hold (`violations`).

import {afterAll, expect} from 'vitest';
import type {
  BarrierOKMessage, Change, ClientMessage, DeltaMessage, GroupRequest, ServerMessage, SubscribedMessage, WelcomeMessage,
} from '../src/protocol/types.gen.ts';
import {openSSE, openWebSocket, type Transport} from '../src/sync/transport.ts';
import {env} from './env.ts';
import {sleep} from './forgejo.ts';
import {type Loaded, type Replica, load, stateOf} from './replica.ts';
import {FetchEventSource} from './sse.ts';

export type Kind = 'ws' | 'sse';
type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, {type: T}>;

interface Waiter {
  from: number;
  match: (m: ServerMessage) => boolean;
  resolve: (m: ServerMessage) => void;
}

export class Session {
  readonly messages: ServerMessage[] = [];
  /** Broken invariants (a test asserts this stays empty). */
  readonly violations: string[] = [];
  /** The viewer (from the welcome): the only user whose profile may arrive outside a held group. */
  viewerId: number | undefined;
  /** Set when the transport closed (WebSocket close code, if any). */
  closed: {code?: number; reason?: string} | undefined;
  /** Groups the session holds a subscription of, with the units of their last grant. */
  readonly granted = new Map<string, string[]>();
  /** Per group: the position (B5 client contract: highest v received, raised by to/caught_up/pong/barrier_ok). */
  readonly positions = new Map<string, number>();
  private readonly caughtUp = new Set<string>();
  private transport!: Transport;
  private waiters: Waiter[] = [];
  private closeWaiters: (() => void)[] = [];
  private seq = 0;

  readonly kind: Kind;

  private constructor(kind: Kind) {
    this.kind = kind;
  }

  /** Opens a transport to the server (resolves once it can send). */
  static open(kind: Kind): Promise<Session> {
    const s = new Session(kind);
    return new Promise((resolve, reject) => {
      const endpoint = `${env.url}/-/sync`;
      const handlers = {
        open: () => {
          resolve(s);
        },
        message: (m: ServerMessage) => {
          s.receive(m);
        },
        close: (info: {opened: boolean; code?: number; reason?: string}) => {
          s.closed = {...(info.code === undefined ? {} : {code: info.code}), ...(info.reason === undefined ? {} : {reason: info.reason})};
          for (const w of s.closeWaiters) w();
          s.closeWaiters = [];
          if (!info.opened) reject(new Error(`${kind} transport did not open: ${info.reason ?? info.code ?? ''}`));
        },
      };
      const tenv = {base: env.url, WebSocket: globalThis.WebSocket, EventSource: FetchEventSource as unknown as typeof EventSource};
      s.transport = kind === 'ws' ? openWebSocket(endpoint, handlers, tenv) : openSSE(endpoint, handlers, tenv);
    });
  }

  send(msg: ClientMessage): void {
    this.transport.send(msg);
  }

  close(): void {
    this.transport.close();
  }

  /** Resolves when the transport is closed (by either side). */
  whenClosed(timeout = 15_000): Promise<{code?: number; reason?: string}> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`${this.kind} session did not close`));
      }, timeout);
      this.closeWaiters.push(() => {
        clearTimeout(t);
        resolve(this.closed ?? {});
      });
    });
  }

  /** The index the next message will have (for `next(…, {from})`). */
  get mark(): number {
    return this.messages.length;
  }

  /** The first message of a type (matching `pred`) received at or after `from` (default: from the start). */
  async next<T extends ServerMessage['type']>(type: T, pred: (m: Msg<T>) => boolean = () => true, o: {from?: number; timeout?: number} = {}): Promise<Msg<T>> {
    return await this.wait(type, (m) => m.type === type && pred(m as Msg<T>), o) as Msg<T>;
  }

  /** The first message matching `match` received at or after `from` (default: from the start). */
  wait(what: string, match: (m: ServerMessage) => boolean, o: {from?: number; timeout?: number} = {}): Promise<ServerMessage> {
    const from = o.from ?? 0;
    for (let i = from; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m && match(m)) return Promise.resolve(m);
    }
    const timeout = o.timeout ?? 20_000;
    return new Promise((resolve, reject) => {
      const w: Waiter = {from, match, resolve: (m) => {
        clearTimeout(t);
        resolve(m);
      }};
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`${this.kind}: no ${what} within ${timeout} ms; got ${this.describe(from)}`));
      }, timeout);
      this.waiters.push(w);
    });
  }

  /** Every change received (in order), optionally only those at or after message index `from`. */
  changes(pred: (c: Change) => boolean = () => true, from = 0): Change[] {
    const out: Change[] = [];
    for (let i = from; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m?.type === 'delta') out.push(...m.changes.filter(pred));
    }
    return out;
  }

  /** Waits for a change matching `pred` received at or after `from`. */
  async change(pred: (c: Change) => boolean, o: {from?: number; timeout?: number} = {}): Promise<Change> {
    const d = await this.next('delta', (m) => m.changes.some(pred), o);
    const c = d.changes.find(pred);
    if (!c) throw new Error('unreachable');
    return c;
  }

  /** hello → welcome (or session_invalid). */
  async hello(token: string, groups?: GroupRequest[]): Promise<WelcomeMessage> {
    const from = this.mark;
    this.send({type: 'hello', token, protocol: 1, client_id: 'conformance', ...(groups ? {groups} : {})});
    const m = await this.wait('welcome', (x) => x.type === 'welcome' || x.type === 'session_invalid', {from});
    if (m.type === 'session_invalid') throw new Error(`session_invalid: ${m.message}`);
    if (m.type !== 'welcome') throw new Error('unreachable');
    return m;
  }

  async subscribe(groups: GroupRequest[]): Promise<SubscribedMessage> {
    const from = this.mark;
    this.send({type: 'subscribe', groups});
    return this.next('subscribed', undefined, {from});
  }

  /** subscribe and wait for the caught_up that follows the replays. */
  async subscribeCaughtUp(groups: GroupRequest[]): Promise<SubscribedMessage> {
    const from = this.mark;
    const sub = await this.subscribe(groups);
    await this.next('caught_up', undefined, {from});
    return sub;
  }

  async barrier(): Promise<BarrierOKMessage> {
    const id = `b${++this.seq}`;
    const from = this.mark;
    this.send({type: 'barrier', id});
    return this.next('barrier_ok', (m) => m.id === id, {from});
  }

  position(group: string): number | undefined {
    return this.positions.get(group);
  }

  private raiseAll(v: number): void {
    for (const g of this.caughtUp) if ((this.positions.get(g) ?? 0) < v) this.positions.set(g, v);
  }

  private receive(m: ServerMessage): void {
    if (m.type === 'delta') this.violations.push(...deltaViolations(m, (g) => this.granted.has(g), this.viewerId));
    this.messages.push(m);
    switch (m.type) {
      case 'welcome':
        this.viewerId = m.viewer_id;
        for (const g of m.granted) this.granted.set(g.group, g.units);
        break;
      case 'subscribed':
        for (const g of m.granted) this.granted.set(g.group, g.units);
        break;
      case 'delta':
        for (const c of m.changes) if (this.granted.has(c.g) && (this.positions.get(c.g) ?? 0) < c.v) this.positions.set(c.g, c.v);
        this.raiseAll(m.to);
        break;
      case 'caught_up':
        for (const g of this.granted.keys()) this.caughtUp.add(g);
        this.raiseAll(m.sync_id);
        break;
      case 'pong':
      case 'barrier_ok':
      case 'resume_from_cursor':
        this.raiseAll(m.sync_id);
        break;
      case 'group_revoked':
        this.granted.delete(m.group);
        this.caughtUp.delete(m.group);
        break;
      default:
    }
    const waiters = this.waiters;
    this.waiters = [];
    const idx = this.messages.length - 1;
    for (const w of waiters) {
      if (idx >= w.from && w.match(m)) w.resolve(m);
      else this.waiters.push(w);
    }
  }

  private describe(from: number): string {
    return this.messages.slice(from).map((m) => m.type === 'delta' ? `delta(${m.changes.map((c) => `${c.m}:${c.id}${c.op}@${c.v}`).join(',')})` : m.type).join(' ') || 'nothing';
  }
}

/**
 * The invariants every delta holds, whatever the scenario: no change of a
 * pseudo group (`*`, `!…`); no change of a group the session does not hold,
 * except an upsert of the viewer's own profile (the hub sends it outside the
 * viewer's groups, WelcomeMessage.profile) — anyone else's profile outside
 * a held group is a leak; sync ids ascending per group within the frame; a
 * payload exactly on upserts.
 */
export function deltaViolations(m: DeltaMessage, holds: (group: string) => boolean, viewerId: number | undefined): string[] {
  const out: string[] = [];
  const last = new Map<string, number>();
  for (const c of m.changes) {
    if (c.g === '*' || c.g.startsWith('!')) out.push(`change in pseudo group ${c.g}`);
    const ownProfile = c.m === 'User' && c.op === 'U' && viewerId !== undefined && c.id === viewerId;
    if (!holds(c.g) && !ownProfile) out.push(`change of ${c.g} (${c.m} ${c.id} ${c.op}), which the session does not hold`);
    if ((last.get(c.g) ?? 0) >= c.v) out.push(`changes of ${c.g} out of sync id order (${c.v})`);
    if (c.op === 'U' && c.d === undefined) out.push(`upsert without payload (${c.m} ${c.id})`);
    if (c.op === 'D' && c.d !== undefined) out.push(`delete with payload (${c.m} ${c.id})`);
    last.set(c.g, c.v);
  }
  return out;
}

/**
 * The sessions a test file opens (push them): after the file all of them
 * are closed, then the invariant violations of all of them are asserted
 * together (each labelled with its session), so one failing session neither
 * leaves the others open nor hides their violations.
 */
export function closedAfterAll(): Session[] {
  const list: Session[] = [];
  afterAll(() => {
    for (const s of list) s.close();
    expect(list.flatMap((s, i) => s.violations.map((v) => `session ${i} (${s.kind}): ${v}`))).toEqual([]);
  });
  return list;
}

/**
 * Asserts that `replica`, fed with every change of `group` the session `s`
 * received (from message `from` on), equals a fresh bootstrap of the group.
 * Server-side writes can follow a write asynchronously (e.g. a label's
 * stats recalculation, a queue job ~1–2 s after the rename, rewrites the
 * label and its updated_at), so the comparison is made only over a quiet
 * window: barrier B1, the bootstrap (watermark W, B1 ≤ W), barrier B2
 * (W ≤ B2); when no change of the group arrived between B1 and B2, the
 * group's state at B1 (the replica) is its state at W (the bootstrap) and
 * they must be equal. Otherwise it tries again, until `timeout` — then the
 * last comparison fails with its diff (a missed change never converges).
 */
export async function expectConverged(s: Session, replica: Replica, token: string, group: string, o: {from?: number; timeout?: number} = {}): Promise<Loaded> {
  const deadline = Date.now() + (o.timeout ?? 20_000);
  for (;;) {
    await s.barrier();
    const quietFrom = s.mark;
    for (const c of s.changes((x) => x.g === group, o.from ?? 0)) replica.apply(c);
    const fresh = await load(token, group);
    await s.barrier();
    const quiet = s.changes((x) => x.g === group, quietFrom).length === 0;
    if (quiet || Date.now() > deadline) {
      expect(replica.state(group), `${group}: replica vs a fresh bootstrap${quiet ? '' : ' (the group never stayed quiet)'}`).toEqual(stateOf(fresh));
      return fresh;
    }
    await sleep(250);
  }
}

/** Opens a session and says hello. */
export async function connect(kind: Kind, token: string, groups?: GroupRequest[]): Promise<{s: Session; welcome: WelcomeMessage}> {
  const s = await Session.open(kind);
  const welcome = await s.hello(token, groups);
  return {s, welcome};
}
