// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Browser tabs of one user for the intent queue's tests: each tab has its
// own pool (fed from the fake server's sync log when the test delivers),
// overlay and Intents, all on one IndexedDB (fake-indexeddb) and one
// in-memory "BroadcastChannel". One tab leads; `crash` kills a tab at any
// point (its in-flight work is abandoned, as when a tab is closed or dies)
// and the next tab takes over.

import {IDBFactory} from 'fake-indexeddb';
import {observable, runInAction} from 'mobx';
import {openDatabase} from '../data/idb.ts';
import {Pool} from '../data/pool.ts';
import {type Channel, type IntentEnv, type IntentMessage, Intents} from '../intents/executor.ts';
import {Overlay} from '../intents/overlay.ts';
import {IntentDb} from '../intents/store.ts';
import {DEV, type FakeForgejo} from './fakeForgejo.ts';

export class Bus {
  private readonly handlers = new Map<number, (m: IntentMessage) => void>();
  /** Messages dropped (a tab that died mid-post). */
  open(tab: number): Channel {
    return {
      post: (m) => {
        const copy = structuredClone(m);
        for (const t of this.handlers.keys()) {
          if (t !== tab) queueMicrotask(() => {
            this.handlers.get(t)?.(structuredClone(copy));
          });
        }
      },
      onMessage: (fn) => {
        this.handlers.set(tab, fn);
        return () => this.handlers.delete(tab);
      },
      close: () => this.handlers.delete(tab),
    };
  }
}

export class Tab {
  readonly n: number;
  readonly pool = new Pool();
  readonly overlay = new Overlay();
  readonly intents: Intents;
  position = 0;
  readonly state = observable({leader: false, connection: 'live'});
  private readonly waiters: {v: number; resolve: () => void}[] = [];
  private readonly caught = new Set<() => void>();
  private readonly server: FakeForgejo;
  dead = false;

  constructor(n: number, world: World, extra: Partial<IntentEnv> = {}) {
    this.n = n;
    this.server = world.server;
    this.deliver();
    const db = new IntentDb(world.db);
    this.intents = new Intents({
      pool: this.pool, overlay: this.overlay, userId: DEV, db, channel: world.bus.open(n),
      isLeader: () => this.state.leader,
      connection: () => this.state.connection,
      onCaughtUp: (fn) => {
        this.caught.add(fn);
        return () => this.caught.delete(fn);
      },
      onRevoked: () => () => undefined,
      whenSynced: (_g, v) => (this.position >= v ? Promise.resolve() : new Promise((resolve) => this.waiters.push({v, resolve}))),
      token: () => Promise.resolve('tok'),
      refresh: () => Promise.resolve('tok'),
      apiBase: '/api/v1',
      syncApiBase: '/-/sync/api',
      online: () => world.server.online,
      fetch: world.server.fetch as typeof fetch,
      backoff: 1,
      maxBackoff: 8,
      confirmTimeout: 300,
      barrierAfter: 100_000,
      ...extra,
    });
  }

  /** Applies the server's log to this tab's pool (deltas arriving). */
  deliver(): void {
    if (this.dead) return;
    this.position = this.server.deliver(this.pool, this.position);
    for (const w of this.waiters.splice(0)) {
      if (w.v <= this.position) w.resolve();
      else this.waiters.push(w);
    }
  }

  lead(): void {
    runInAction(() => {
      this.state.leader = true;
    });
    this.caughtUp();
  }

  /** The session caught up (the leader may flush). */
  caughtUp(): void {
    for (const fn of this.caught) fn();
  }

  setConnection(c: string): void {
    runInAction(() => {
      this.state.connection = c;
    });
    if (c === 'live') this.caughtUp();
  }

  kill(): void {
    this.dead = true;
    this.intents.close();
  }
}

export class World {
  readonly server: FakeForgejo;
  readonly bus = new Bus();
  readonly db: Promise<IDBDatabase>;
  readonly tabs: Tab[] = [];
  private next = 0;
  private readonly extra: Partial<IntentEnv>;

  constructor(server: FakeForgejo, tabs = 1, extra: Partial<IntentEnv> = {}) {
    this.server = server;
    this.extra = extra;
    this.db = openDatabase(DEV, {factory: new IDBFactory()});
    for (let k = 0; k < tabs; k++) this.spawn();
    this.tabs[0]?.lead();
  }

  spawn(): Tab {
    const t = new Tab(this.next++, this, this.extra);
    this.tabs.push(t);
    return t;
  }

  get leader(): Tab | undefined {
    return this.tabs.find((t) => t.state.leader);
  }

  alive(): Tab[] {
    return this.tabs.filter((t) => !t.dead);
  }

  /** The leader dies (at whatever point its work is); another tab takes over (a new one if none is left). */
  crash(): void {
    const l = this.leader;
    if (!l) return;
    l.kill();
    runInAction(() => {
      l.state.leader = false;
    });
    this.tabs.splice(this.tabs.indexOf(l), 1);
    (this.tabs[0] ?? this.spawn()).lead();
  }

  deliverAll(): void {
    for (const t of this.alive()) t.deliver();
  }

  /** Lets the queue run until nothing moves (or `max` rounds pass). */
  async settle(max = 400): Promise<void> {
    let quiet = 0;
    let last = '';
    for (let round = 0; round < max && quiet < 8; round++) {
      await new Promise((r) => setTimeout(r, round < 20 ? 0 : 2));
      this.deliverAll();
      const sig = `${String(this.server.v)}|${this.alive().map((t) => `${String(t.intents.records.size)}:${String(t.overlay.size)}:${String(t.intents.drafts.size)}`).join(',')}`;
      // Online with work left that is not waiting for the user: not quiet (a backoff runs).
      const busy = this.server.online && [...this.leader?.intents.records.values() ?? []].some((r) => r.state !== 'parked');
      quiet = sig === last && !busy ? quiet + 1 : 0;
      last = sig;
    }
  }

  close(): void {
    for (const t of this.alive()) t.kill();
  }
}
