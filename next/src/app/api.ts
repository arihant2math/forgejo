// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Online-only requests use the session token, write idempotency keys and a timeout.
// Redirects are forbidden so the token cannot follow them. Offline-capable writes use intents.

import {uuid} from '../intents/intents.ts';
import {APIPrefix, HeaderIdempotencyKey, HeaderSyncID} from '../protocol/types.gen.ts';
import {netSignal} from '../sync/net.ts';
import {sitePath} from './config.ts';
import type {App} from './store.ts';

export interface OnlineRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  api: 'v1' | 'sync';
  path: string;
  body?: unknown;
  /** No Idempotency-Key: keyed bodies are buffered up to 16 MiB, but uploads can be larger. */
  form?: FormData | undefined;
  signal?: AbortSignal | undefined;
  timeout?: number;
}

const answered = (status: number) => `Forgejo answered ${String(status)}.`;

export class RequestFailed extends Error {
  override name = 'RequestFailed';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Sends the request and returns its parsed JSON (undefined for an empty answer); throws RequestFailed. */
export async function online<T = unknown>(app: App, req: OnlineRequest): Promise<T | undefined> {
  return (await send<T>(app, req)).value;
}

/** A write's response and its X-Livesync-Sync-Id position, when provided. */
export interface Written<T> {
  totalCount: number | undefined;
  value: T | undefined;
  syncId: number | undefined;
}

/** Returns the echoed sync id for Data.whenSynced; throws RequestFailed. */
export function onlineWrite<T = unknown>(app: App, req: OnlineRequest): Promise<Written<T>> {
  return send<T>(app, req);
}

export async function send<T>(app: App, req: OnlineRequest): Promise<Written<T>> {
  const s = app.session;
  if (!s) throw new RequestFailed(0, 'Not signed in.');
  const method = req.method ?? 'GET';
  const token = await s.auth.token();
  const body = req.form ?? (req.body === undefined ? undefined : JSON.stringify(req.body));
  let res: Response;
  try {
    res = await fetch(sitePath(app.config, `${req.api === 'v1' ? '/api/v1' : APIPrefix}${req.path}`), {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        ...(method === 'GET' || req.form ? {} : {[HeaderIdempotencyKey]: uuid()}),
        // Let the browser set the multipart boundary.
        ...(body === undefined || req.form ? {} : {'Content-Type': 'application/json'}),
      },
      ...(body === undefined ? {} : {body}),
      credentials: 'omit',
      redirect: 'manual',
      signal: netSignal(req.timeout ?? 15_000, req.signal),
    });
  } catch (err) {
    if (req.signal?.aborted) throw err;
    throw new RequestFailed(0, 'Forgejo could not be reached.');
  }
  if (res.type === 'opaqueredirect') throw new RequestFailed(0, 'Forgejo answered with a redirect.');
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const msg = json && typeof json === 'object' && typeof (json as {message?: unknown}).message === 'string' ? (json as {message: string}).message : '';
    throw new RequestFailed(res.status, msg || answered(res.status));
  }
  const v = Number(res.headers.get(HeaderSyncID));
  const count = res.headers.get('X-Total-Count');
  const totalCount = count === null ? undefined : Number(count);
  return {value: json as T | undefined, totalCount: totalCount !== undefined && Number.isSafeInteger(totalCount) && totalCount >= 0 ? totalCount : undefined, syncId: Number.isSafeInteger(v) && v > 0 ? v : undefined};
}

/** Forgejo refused the request (a 4xx other than a timeout or a rate limit): trying it again would be refused again. */
export function refused(err: unknown): boolean {
  return err instanceof RequestFailed && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/** User-facing failure text omits internal addresses and stacks; full details go to the console. */
export function failureText(err: unknown): string {
  const status = err instanceof RequestFailed ? err.status : 0;
  const raw = err instanceof Error ? err.message.trim() : '';
  // A status-only fallback carries no server reason; use the actionable status message.
  const said = err instanceof RequestFailed && raw === answered(status) ? '' : raw;
  if (/not allowed to merge|not in mergeable state|User not allowed to merge PR/i.test(said)) {
    if (/enough approvals/i.test(said)) return 'More approvals are required before this pull request can be merged.';
    if (/reject|change.?request/i.test(said)) return 'A change request is blocking this merge.';
    if (/status|check/i.test(said)) return 'Required checks must pass before this pull request can be merged.';
    if (/whitelist|permission|User not allowed/i.test(said)) return 'You are not allowed to merge into this protected branch.';
    return 'This pull request cannot be merged yet. Check its reviews, required checks and branch protection rules.';
  }
  if (said && said.length <= 140 && !/\n|https?:\/\/|unix|\.sock\b|\bdial\b|\bpanic\b|[A-Z][a-z]+Error:|PushRejected/.test(said)) return said;
  if (said) console.warn('Forgejo said:', said);
  if (status === 0) return 'Forgejo could not be reached.';
  if (status === 409 || status === 405) return 'Forgejo could not do it now (the branch changed, or a hook refused it). Check the pull request, then try again.';
  if (status >= 500) return 'Forgejo ran into an error. Try again in a moment.';
  return `Forgejo refused it (HTTP ${String(status)}).`;
}
