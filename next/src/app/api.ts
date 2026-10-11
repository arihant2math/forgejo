// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Online-only requests (PLAN §5.4: never queued — board columns, markdown
// previews, the server's search): API v1 or livesync's gap endpoints (B9),
// with the session's token, an Idempotency-Key on writes, no redirects
// (the token never follows one) and a timeout. Offline-capable writes are
// intents (src/intents), never this.

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
  /**
   * A multipart body instead (a file upload: a release's asset). Sent without an Idempotency-Key: B7 buffers a
   * keyed body (16 MiB at most), and a file can be larger.
   */
  form?: FormData | undefined;
  signal?: AbortSignal | undefined;
  timeout?: number;
}

/** A request that failed: the server's message when it gave one. */
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

/** A write's answer and the sync log position that holds it (X-Livesync-Sync-Id, PLAN §4.8), when the server gave one. */
export interface Written<T> {
  value: T | undefined;
  syncId: number | undefined;
}

/**
 * An online write that the page goes on from once the pool holds it (a created pull request's page): its answer
 * with the echoed sync id, for Data.whenSynced. Throws RequestFailed.
 */
export function onlineWrite<T = unknown>(app: App, req: OnlineRequest): Promise<Written<T>> {
  return send<T>(app, req);
}

async function send<T>(app: App, req: OnlineRequest): Promise<Written<T>> {
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
        // A form's type (multipart, with its boundary) is the browser's.
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
    throw new RequestFailed(res.status, msg || `Forgejo answered ${String(res.status)}.`);
  }
  const v = Number(res.headers.get(HeaderSyncID));
  return {value: json as T | undefined, syncId: Number.isSafeInteger(v) && v > 0 ? v : undefined};
}

/** Forgejo refused the request (a 4xx other than a timeout or a rate limit): trying it again would be refused again. */
export function refused(err: unknown): boolean {
  return err instanceof RequestFailed && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/**
 * Why an online action failed, for people: Forgejo's message when it is one (short, no internal addresses or
 * stack: a failed hook prints sockets and URLs), else what happened in general. The whole message goes to the
 * console for whoever needs it.
 */
export function failureText(err: unknown): string {
  const status = err instanceof RequestFailed ? err.status : 0;
  const said = err instanceof Error ? err.message.trim() : '';
  if (said && said.length <= 140 && !/\n|https?:\/\/|unix|\.sock\b|\bdial\b|\bpanic\b|[A-Z][a-z]+Error:|PushRejected/.test(said)) return said;
  if (said) console.warn('Forgejo said:', said);
  if (status === 0) return 'Forgejo could not be reached.';
  if (status === 409 || status === 405) return 'Forgejo could not do it now (the branch changed, or a hook refused it). Check the pull request, then try again.';
  if (status >= 500) return 'Forgejo ran into an error. Try again in a moment.';
  return `Forgejo refused it (HTTP ${String(status)}).`;
}
