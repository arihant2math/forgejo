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
//                    shows the same value: no flicker. Without the header
//                    (the server's wait timed out) the layer stays until a
//                    change of the issue arrives;
//   reject         → 4xx, offline, or retries used up: the layer is removed
//                    (the UI shows the server's value again) and onRejected
//                    tells the user, who may retry it as a new intent.

import {observable, runInAction} from 'mobx';
import type {Applied, Pool} from '../data/pool.ts';
import {HeaderIdempotencyKey, HeaderSyncID} from '../protocol/types.gen.ts';
import {type Intent, type IntentInput, intentOps, type IntentStore, MemoryIntentStore, newIntent} from './intents.ts';
import type {Overlay} from './overlay.ts';
import {requestFor, UnsendableIntent} from './rest.ts';

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
  whenSynced(group: string, v: number): Promise<void>;
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
  /** Base of the retry backoff (ms, default 500). */
  backoff?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_RETRIES = 4;

/** The phase of an intent in flight (observable through Intents.phase). */
export type IntentPhase = 'sending' | 'confirming';

export class Intents {
  private readonly env: IntentEnv;
  private readonly store: IntentStore;
  /** Per issue: the end of the last queued send (sends of one issue are serial, PLAN §5.4). */
  private readonly chains = new Map<number, Promise<void>>();
  /** The intents not confirmed or rejected yet, with their phase. */
  readonly phases = observable.map<string, IntentPhase>({}, {deep: false});

  constructor(env: IntentEnv) {
    this.env = env;
    this.store = env.store ?? new MemoryIntentStore();
  }

  /** Applies an intent to the overlay at once and sends it; returns it. */
  submit(input: IntentInput): Intent {
    const i = newIntent(input);
    this.env.overlay.add(i.id, intentOps(i));
    this.store.put(i);
    runInAction(() => this.phases.set(i.id, 'sending'));
    const prev = this.chains.get(i.issueId) ?? Promise.resolve();
    const sent = prev.then(() => this.run(i));
    const tail = sent.catch(() => undefined);
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
    try {
      res = await this.send(i);
    } catch (err) {
      this.reject(i, err instanceof RejectedError ? err.rejection : {reason: 'failed', message: String(err)});
      return;
    }
    const v = Number(res.headers.get(HeaderSyncID));
    runInAction(() => this.phases.set(i.id, 'confirming'));
    // Not awaited: the next intent of the issue may be sent while this one waits for its echo.
    void this.confirm(i, Number.isSafeInteger(v) && v > 0 ? v : undefined);
  }

  /** Sends the intent's request, retrying what may succeed later; resolves with a 2xx response. */
  private async send(i: Intent): Promise<Response> {
    const {env} = this;
    const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const backoff = env.backoff ?? 500;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      if (!env.online()) throw new RejectedError({reason: 'offline', message: 'You are offline: changes need a connection for now.'});
      let req;
      try {
        req = requestFor(i, env.pool, env.overlay);
      } catch (err) {
        if (err instanceof UnsendableIntent) throw new RejectedError({reason: 'failed', message: err.message});
        throw err;
      }
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
            ...(req.body === undefined ? {} : {'Content-Type': 'application/json'}),
          },
          ...(req.body === undefined ? {} : {body: JSON.stringify(req.body)}),
          credentials: 'omit',
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        // The same key makes the retry safe whether or not the first attempt reached the server.
        if (!env.online()) throw new RejectedError({reason: 'offline', message: 'You are offline: changes need a connection for now.'});
        if (attempt >= MAX_RETRIES) throw new RejectedError({reason: 'failed', message: 'Forgejo could not be reached.'});
        await sleep(backoff * 2 ** attempt);
        continue;
      }
      if (res.ok) return res;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        if (await env.refresh().catch(() => null)) continue;
        throw new RejectedError({reason: 'failed', status: 401, message: 'You are signed out.'});
      }
      // 409: the same key is in flight (B7); 503: livesync is restarting; 5xx: unknown outcome (the key replays it).
      if ((res.status === 409 || res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const after = Number(res.headers.get('Retry-After'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : backoff * 2 ** attempt);
        continue;
      }
      throw new RejectedError({reason: res.status < 500 ? 'refused' : 'failed', status: res.status, message: await errorMessage(res)});
    }
  }

  /** Drops the layer once the pool holds the write (or gives up waiting after confirmTimeout). */
  private async confirm(i: Intent, v: number | undefined): Promise<void> {
    const {env} = this;
    const group = `repo:${String(i.repoId)}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let off: (() => void) | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, env.confirmTimeout ?? 60_000);
    });
    const arrived = v !== undefined ?
      env.whenSynced(group, v) :
      // No sync id: keep the layer until a change of the issue arrives (B7 notes, "For F2/F5").
      new Promise<void>((resolve) => {
        off = env.pool.onApplied((changes) => {
          if (changes.some((c) => touches(c, i))) resolve();
        });
      });
    try {
      await Promise.race([arrived, timeout]);
    } finally {
      clearTimeout(timer);
      off?.();
      this.done(i);
    }
  }

  private reject(i: Intent, r: Rejection): void {
    this.done(i);
    this.env.onRejected(i, r);
  }

  private done(i: Intent): void {
    this.env.overlay.remove(i.id);
    this.store.delete(i.id);
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

/** Whether an applied change is about the intent's issue. */
function touches(c: Applied, i: Intent): boolean {
  if (c.model === 'Issue') return c.id === i.issueId;
  const d = c.entity?.data as {issue_id?: number} | undefined;
  if (c.model === 'IssueLabel' || c.model === 'IssueAssignee') return d?.issue_id === i.issueId || d === undefined;
  return false;
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
