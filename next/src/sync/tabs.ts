// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Tab coordination (PLAN §5.3): one leader tab per (origin, user), elected
// with the Web Locks API — the lock is held for the tab's lifetime and
// passes to a waiting tab when the leader closes or crashes. The leader owns
// the sync session and every IndexedDB write. Tabs talk over a
// BroadcastChannel: the leader announces each committed flush (followers
// mirror IndexedDB from it), its status and events; followers send the
// groups they hold, and requests (barrier, closed pages; F5: intents).
// Without Web Locks (very old browsers, tests) every tab is its own leader;
// without BroadcastChannel tabs do not hear each other.

import type {BucketWrite} from '../data/persist.ts';
import type {ModelName} from '../data/models.ts';
import type {SyncEvents, SyncStatus} from './client.ts';

export type TabMessage =
  | {t: 'commit'; seq: number; buckets: BucketWrite[]; cleared: ModelName[]; dropped: string[]}
  | {t: 'leader'; tab: string}
  | {t: 'status'; status: SyncStatus}
  | {t: 'event'; name: keyof SyncEvents; e: SyncEvents[keyof SyncEvents]}
  | {t: 'hello'; tab: string}
  | {t: 'alive'; tab: string; holds: string[]}
  | {t: 'hold'; tab: string; group: string; on: boolean}
  | {t: 'bye'; tab: string}
  | {t: 'req'; tab: string; id: number; op: string; args: unknown[]}
  | {t: 'res'; tab: string; id: number; ok: boolean; value?: unknown; error?: string};

export interface TabsEnv {
  /** null: no Web Locks (this tab leads alone). */
  locks?: LockManager | null;
  /** null: no BroadcastChannel. */
  BroadcastChannel?: typeof BroadcastChannel | null;
}

export class Tabs {
  readonly id: string;
  private readonly name: string;
  private readonly channel: BroadcastChannel | undefined;
  private readonly locks: LockManager | undefined;
  private readonly handlers = new Set<(m: TabMessage) => void>();
  private releaseLock: (() => void) | undefined;
  private abort = new AbortController();
  private closed = false;

  constructor(name: string, env: TabsEnv = {}) {
    this.name = name;
    this.id = randomId();
    const BC = env.BroadcastChannel === undefined ? globalThis.BroadcastChannel as typeof BroadcastChannel | undefined : env.BroadcastChannel;
    if (BC) {
      this.channel = new BC(name);
      this.channel.onmessage = (ev: MessageEvent<TabMessage>) => {
        for (const h of this.handlers) h(ev.data);
      };
    }
    const locks = env.locks === undefined ? (globalThis.navigator as Navigator | undefined)?.locks : env.locks;
    if (locks) this.locks = locks;
  }

  /** Whether tabs can hear each other. */
  get hasChannel(): boolean {
    return this.channel !== undefined;
  }

  /** Whether leadership is elected (otherwise every tab leads alone). */
  get hasLocks(): boolean {
    return this.locks !== undefined;
  }

  onMessage(fn: (m: TabMessage) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  post(m: TabMessage): void {
    if (this.closed) return;
    try {
      this.channel?.postMessage(m);
    } catch (err) {
      console.error('livesync: broadcast failed', err);
    }
  }

  /** Waits for leadership; calls `onLeader` once this tab holds the lock. */
  elect(onLeader: () => void): void {
    if (!this.locks) {
      queueMicrotask(onLeader);
      return;
    }
    this.locks.request(`${this.name}:leader`, {signal: this.abort.signal}, () => {
      if (this.closed) return undefined;
      onLeader();
      // Held until the tab closes (or close()).
      return new Promise<void>((resolve) => {
        this.releaseLock = resolve;
      });
    }).catch(() => {
      // Aborted by close().
    });
  }

  close(): void {
    if (this.closed) return;
    this.post({t: 'bye', tab: this.id});
    this.closed = true;
    this.abort.abort();
    this.releaseLock?.();
    this.channel?.close();
    this.handlers.clear();
  }
}

function randomId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
