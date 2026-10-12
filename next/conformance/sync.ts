// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Use the app's transports but assert wire behaviour independently of its data layer.

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
  readonly violations: string[] = [];
  /** The viewer (from the welcome): the only user whose profile may arrive outside a held group. */
  viewerId: number | undefined;
  closed: {code?: number; reason?: string} | undefined;
  /** Groups the session holds a subscription of, with the units of their last grant. */
  readonly granted = new Map<string, string[]>();
  /** Per-group cursor: highest v received, raised by to/caught_up/pong/barrier_ok. */
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

  async change(pred: (c: Change) => boolean, o: {from?: number; timeout?: number} = {}): Promise<Change> {
    const d = await this.next('delta', (m) => m.changes.some(pred), o);
    const c = d.changes.find(pred);
    if (!c) throw new Error('unreachable');
    return c;
  }

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

/** Reject pseudo or unheld groups (except viewer profile upserts), descending per-group IDs, and invalid payloads. */
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

/** Closes all registered sessions, then asserts their invariants so failures cannot skip cleanup. */
export function closedAfterAll(): Session[] {
  const list: Session[] = [];
  afterAll(() => {
    for (const s of list) s.close();
    expect(list.flatMap((s, i) => s.violations.map((v) => `session ${i} (${s.kind}): ${v}`))).toEqual([]);
  });
  return list;
}

/**
 * Compares the replica with a fresh bootstrap between two barriers with no group changes.
 * Async server jobs can rewrite entities after a write's echo; retries until timeout (ms).
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

export async function connect(kind: Kind, token: string, groups?: GroupRequest[]): Promise<{s: Session; welcome: WelcomeMessage}> {
  const s = await Session.open(kind);
  const welcome = await s.hello(token, groups);
  return {s, welcome};
}
