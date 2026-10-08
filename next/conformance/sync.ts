// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A raw sync protocol client (B5): the Next app's own transports
// (src/sync/transport.ts: WebSocket, or SSE + POST) carry the messages, but
// everything above them — hello, subscriptions, positions — is done here,
// message by message, so that the scenarios assert the server's wire
// behaviour and not the app's interpretation of it. Every message received
// is kept (`messages`) and checked against the invariants every message must
// hold (`violations`).

import type {
  BarrierOKMessage, Change, ClientMessage, GroupRequest, ServerMessage, SubscribedMessage, WelcomeMessage,
} from '../src/protocol/types.gen.ts';
import {openSSE, openWebSocket, type Transport} from '../src/sync/transport.ts';
import {env} from './env.ts';
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
    this.check(m);
    this.messages.push(m);
    switch (m.type) {
      case 'welcome':
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

  /** Invariants every server message holds, whatever the scenario. */
  private check(m: ServerMessage): void {
    if (m.type !== 'delta') return;
    const last = new Map<string, number>();
    for (const c of m.changes) {
      if (c.g === '*' || c.g.startsWith('!')) this.violations.push(`change in pseudo group ${c.g}`);
      if (!this.granted.has(c.g) && !(c.m === 'User' && c.op === 'U')) this.violations.push(`change of ${c.g}, which the session does not hold`);
      if ((last.get(c.g) ?? 0) >= c.v) this.violations.push(`changes of ${c.g} out of sync id order (${c.v})`);
      if (c.op === 'U' && c.d === undefined) this.violations.push(`upsert without payload (${c.m} ${c.id})`);
      if (c.op === 'D' && c.d !== undefined) this.violations.push(`delete with payload (${c.m} ${c.id})`);
      last.set(c.g, c.v);
    }
  }

  private describe(from: number): string {
    return this.messages.slice(from).map((m) => m.type === 'delta' ? `delta(${m.changes.map((c) => `${c.m}:${c.id}${c.op}@${c.v}`).join(',')})` : m.type).join(' ') || 'nothing';
  }
}

/** Opens a session and says hello. */
export async function connect(kind: Kind, token: string, groups?: GroupRequest[]): Promise<{s: Session; welcome: WelcomeMessage}> {
  const s = await Session.open(kind);
  const welcome = await s.hello(token, groups);
  return {s, welcome};
}
