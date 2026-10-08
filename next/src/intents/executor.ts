// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Runs intents online (F4; F5 adds the durable offline queue around it):
//
//   submit(input)  → the overlay layer is applied synchronously (the UI shows
//                    the change in the same frame), the intent is stored and
//                    queued behind earlier intents of the same issue;
//   send           → its API v1 call with the intent's Idempotency-Key (the
//                    same key on every retry, B7);
//   confirm        → 2xx with X-Livesync-Sync-Id = v: the overlay layer is
//                    dropped once the pool holds the repository group up to v
//                    (Data.whenSynced), so the server state that replaces it
//                    shows the same value: no flicker (a barrier raises the
//                    position when it is slow). Without the header (the
//                    server's wait timed out) the layer stays until the pool
//                    shows the intent's own effect;
//   reject         → 4xx, offline, or retries used up: the layer is removed
//                    (the UI shows the server's value again) and onRejected
//                    tells the user, who may retry it as a new intent.

import {observable, runInAction, untracked} from 'mobx';
import type {Pool} from '../data/pool.ts';
import {HeaderIdempotencyKey, HeaderSyncID} from '../protocol/types.gen.ts';
import {type Intent, type IntentInput, intentOps, type IntentStore, MemoryIntentStore, newIntent} from './intents.ts';
import type {Overlay} from './overlay.ts';
import {requestFor, UnsendableIntent} from './rest.ts';
import {serverMembers} from './view.ts';

export interface Rejection {
  /** offline: no connection (F5 will queue instead); refused: the server said no (status); failed: anything else. */
  reason: 'offline' | 'refused' | 'failed';
  status?: number;
  message: string;
}

export interface IntentEnv {
  pool: Pool;
  overlay: Overlay;
  /** Data.whenSynced. */
  whenSynced(group: string, v: number, signal?: AbortSignal): Promise<void>;
  /** Data.barrier: raises every subscribed group's position to the server's (when an echo is slow to be reached). */
  barrier?(): Promise<unknown>;
  /** A current access token; rejects when signed out. */
  token(): Promise<string>;
  /** The server refused the token: a new one, or null. */
  refresh(): Promise<string | null>;
  /** API v1's base URL ("/api/v1" below the instance's sub-path). */
  apiBase: string;
  online(): boolean;
  onRejected(i: Intent, r: Rejection): void;
  store?: IntentStore;
  fetch?: typeof fetch;
  /** How long a confirmation may take before the layer is dropped anyway (ms, default 60 s). */
  confirmTimeout?: number;
  /** How long to wait for the echo before asking for a barrier (ms, default 3 s). */
  barrierAfter?: number;
  /** Base of the retry backoff (ms, default 500). */
  backoff?: number;
  /** How long a write may wait for "in flight" answers (409) before giving up (ms, default 60 s). */
  inFlightLimit?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Attempts for answers of unknown outcome (network errors, 5xx); the key makes each retry safe. */
const MAX_RETRIES = 4;

/** Requests in flight at once, across issues (a bulk edit of many issues queues behind them). */
const MAX_SENDS = 6;

/** The phase of an intent in flight (observable through Intents.phases). */
export type IntentPhase = 'sending' | 'confirming';

export class Intents {
  private readonly env: IntentEnv;
  private readonly store: IntentStore;
  /** Per issue: the end of the last queued send (sends of one issue are serial, PLAN §5.4). */
  private readonly chains = new Map<number, Promise<void>>();
  /** The intents not confirmed or rejected yet, with their phase. */
  readonly phases = observable.map<string, IntentPhase>({}, {deep: false});
  /** Submission order of the pending intents. */
  private readonly order = new Map<string, number>();
  private submitted = 0;
  /** Intents confirmed without a sync id, waiting for their own effect: released early by a later echo of their issue. */
  private readonly awaitingEffect = new Map<string, {issueId: number; release: () => void}>();
  private sending = 0;
  private readonly sendQueue: (() => void)[] = [];
  private barrierPending: Promise<unknown> | undefined;

  constructor(env: IntentEnv) {
    this.env = env;
    this.store = env.store ?? new MemoryIntentStore();
  }

  /** Applies an intent to the overlay at once and sends it (once stored); returns it. */
  submit(input: IntentInput): Intent {
    const i = newIntent(input);
    this.order.set(i.id, ++this.submitted);
    this.env.overlay.add(i.id, intentOps(i));
    runInAction(() => this.phases.set(i.id, 'sending'));
    const stored = Promise.resolve(this.store.put(i));
    const prev = this.chains.get(i.issueId) ?? Promise.resolve();
    const sent = Promise.all([prev, stored]).then(() => this.run(i));
    const tail = sent.catch((err: unknown) => {
      this.reject(i, {reason: 'failed', message: String(err)});
    });
    this.chains.set(i.issueId, tail);
    void tail.then(() => {
      if (this.chains.get(i.issueId) === tail) this.chains.delete(i.issueId);
    });
    return i;
  }

  /** Intents not confirmed or rejected yet. */
  get pending(): number {
    return this.phases.size;
  }

  private async run(i: Intent): Promise<void> {
    let res: Response;
    if (this.sending >= MAX_SENDS) await new Promise<void>((resolve) => this.sendQueue.push(resolve));
    this.sending++;
    try {
      res = await this.send(i);
    } catch (err) {
      this.reject(i, err instanceof RejectedError ? err.rejection : {reason: 'failed', message: String(err)});
      return;
    } finally {
      this.sending--;
      this.sendQueue.shift()?.();
    }
    const v = Number(res.headers.get(HeaderSyncID));
    runInAction(() => this.phases.set(i.id, 'confirming'));
    // Not awaited: the next intent of the issue may be sent while this one waits for its echo.
    void this.confirm(i, Number.isSafeInteger(v) && v > 0 ? v : undefined);
  }

  /**
   * Sends the intent's request, retrying what may succeed later; resolves with a 2xx response. The
   * request is built once, from the pool as it is at the first attempt: every retry under the same
   * Idempotency-Key must be the same request (B7 answers 422 to the same key with another body).
   */
  private async send(i: Intent): Promise<Response> {
    const {env} = this;
    const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const backoff = env.backoff ?? 500;
    const offline = () => new RejectedError({reason: 'offline', message: 'You are offline: changes need a connection for now.'});
    if (!env.online()) throw offline();
    let req;
    try {
      req = requestFor(i, env.pool, env.overlay);
    } catch (err) {
      if (err instanceof UnsendableIntent) throw new RejectedError({reason: 'failed', message: err.message});
      throw err;
    }
    const body = req.body === undefined ? undefined : JSON.stringify(req.body);
    let refreshed = false;
    let failures = 0;
    const inFlightUntil = Date.now() + (env.inFlightLimit ?? 60_000);
    for (;;) {
      let token: string;
      try {
        token = await env.token();
      } catch {
        throw new RejectedError({reason: 'failed', message: 'You are signed out.'});
      }
      let res: Response;
      try {
        res = await (env.fetch ?? fetch)(`${env.apiBase}${req.path}`, {
          method: req.method,
          headers: {
            'Authorization': `Bearer ${token}`,
            [HeaderIdempotencyKey]: i.key,
            'Accept': 'application/json',
            ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
          },
          ...(body === undefined ? {} : {body}),
          credentials: 'omit',
          // The API answers writes directly: never follow a redirect with the token.
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        // The same key makes the retry safe whether or not the attempt reached the server.
        if (!env.online()) throw new RejectedError({reason: 'offline', message: 'The connection dropped while saving: the change may not have been made.'});
        if (++failures > MAX_RETRIES) throw new RejectedError({reason: 'failed', message: 'Forgejo could not be reached.'});
        await sleep(backoff * 2 ** (failures - 1));
        continue;
      }
      if (res.type === 'opaqueredirect') throw new RejectedError({reason: 'failed', message: 'Forgejo answered with a redirect.'});
      if (res.ok) return res;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        if (await env.refresh().catch(() => null)) continue;
        throw new RejectedError({reason: 'failed', status: 401, message: 'You are signed out.'});
      }
      const after = Number(res.headers.get('Retry-After'));
      const wait = Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : undefined;
      // 409: the same key is still running (an earlier attempt): wait for it, without spending attempts.
      if (res.status === 409 && Date.now() < inFlightUntil) {
        await sleep(wait ?? backoff);
        continue;
      }
      // 429 / 503 (livesync restarting) / other 5xx (unknown outcome: the key replays it).
      if ((res.status === 429 || res.status >= 500) && ++failures <= MAX_RETRIES) {
        await sleep(wait ?? backoff * 2 ** (failures - 1));
        continue;
      }
      throw new RejectedError({reason: res.status < 500 ? 'refused' : 'failed', status: res.status, message: await errorMessage(res)});
    }
  }

  /**
   * Drops the layer once the pool holds the write: the group's position reached the echoed sync id
   * (asking for a barrier when that is slow: a write whose entries are elsewhere, or a hub behind its
   * head, would otherwise wait for the next ping), or — without an echo — once the pool shows the
   * intent's own effect. Gives up after confirmTimeout (the layer goes; the pool shows what it has).
   */
  private async confirm(i: Intent, v: number | undefined): Promise<void> {
    const {env} = this;
    const group = `repo:${String(i.repoId)}`;
    const ctrl = new AbortController();
    const timers: ReturnType<typeof setTimeout>[] = [];
    let off: (() => void) | undefined;
    const timeout = new Promise<void>((resolve) => {
      timers.push(setTimeout(resolve, env.confirmTimeout ?? 60_000));
    });
    let arrived: Promise<void>;
    if (v !== undefined) {
      arrived = env.whenSynced(group, v, ctrl.signal);
      if (env.barrier) {
        timers.push(setTimeout(() => {
          this.barrier();
        }, env.barrierAfter ?? 3000));
      }
    } else {
      // No sync id (the server's wait timed out): the intent's own effect in the pool (B7 notes, "For F2/F5").
      arrived = new Promise<void>((resolve) => {
        if (effectHeld(env.pool, i)) {
          resolve();
          return;
        }
        this.awaitingEffect.set(i.id, {issueId: i.issueId, release: resolve});
        off = env.pool.onApplied((changes) => {
          if (changes.some((c) => c.model === 'Issue' || c.model === 'IssueLabel' || c.model === 'IssueAssignee') && effectHeld(env.pool, i)) resolve();
        });
      });
    }
    try {
      const echoed = await Promise.race([arrived.then(() => v !== undefined, () => false), timeout.then(() => false)]);
      // The pool holds the state after this write: earlier intents of the issue still waiting for their own effect
      // are behind it (a later change may have hidden that effect for good), so their layers go too.
      if (echoed) {
        const mine = this.order.get(i.id) ?? 0;
        for (const [id, w] of this.awaitingEffect) if (w.issueId === i.issueId && (this.order.get(id) ?? 0) < mine) w.release();
      }
    } finally {
      this.awaitingEffect.delete(i.id);
      for (const t of timers) clearTimeout(t);
      ctrl.abort();
      off?.();
      this.done(i);
    }
  }

  /** One barrier at a time for every slow echo. */
  private barrier(): void {
    if (this.barrierPending || !this.env.barrier) return;
    this.barrierPending = this.env.barrier().catch(() => undefined).finally(() => {
      this.barrierPending = undefined;
    });
  }

  private reject(i: Intent, r: Rejection): void {
    if (!this.phases.has(i.id)) return;
    this.done(i);
    this.env.onRejected(i, r);
  }

  private done(i: Intent): void {
    this.order.delete(i.id);
    this.env.overlay.remove(i.id);
    void Promise.resolve(this.store.delete(i.id)).catch(() => undefined);
    runInAction(() => this.phases.delete(i.id));
  }
}

class RejectedError extends Error {
  readonly rejection: Rejection;
  constructor(r: Rejection) {
    super(r.message);
    this.rejection = r;
  }
}

/** Whether the pool's server state shows the intent's effect. Untracked plain reads. */
export function effectHeld(pool: Pool, i: Intent): boolean {
  return untracked(() => {
    const issue = pool.model('Issue').get(i.issueId)?.data;
    if (!issue) return false;
    switch (i.kind) {
      case 'issue.state':
        return issue.state === i.state;
      case 'issue.milestone':
        return issue.milestone_id === i.milestoneId;
      case 'issue.label':
        return serverMembers(pool, 'IssueLabel', i.issueId).has(i.labelId) === i.add;
      case 'issue.assignee':
        return serverMembers(pool, 'IssueAssignee', i.issueId).has(i.userId) === i.add;
    }
  });
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const j = await res.json() as {message?: unknown};
    if (typeof j.message === 'string' && j.message) return j.message.slice(0, 300);
  } catch {
    // Not JSON.
  }
  return `Forgejo answered ${String(res.status)}.`;
}
