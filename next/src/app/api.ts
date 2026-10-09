// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Online-only requests (PLAN §5.4: never queued — board columns, markdown
// previews, the server's search): API v1 or livesync's gap endpoints (B9),
// with the session's token, an Idempotency-Key on writes, no redirects
// (the token never follows one) and a timeout. Offline-capable writes are
// intents (src/intents), never this.

import {uuid} from '../intents/intents.ts';
import {APIPrefix, HeaderIdempotencyKey} from '../protocol/types.gen.ts';
import {netSignal} from '../sync/net.ts';
import {sitePath} from './config.ts';
import type {App} from './store.ts';

export interface OnlineRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  api: 'v1' | 'sync';
  path: string;
  body?: unknown;
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
  const s = app.session;
  if (!s) throw new RequestFailed(0, 'Not signed in.');
  const method = req.method ?? 'GET';
  const token = await s.auth.token();
  const body = req.body === undefined ? undefined : JSON.stringify(req.body);
  let res: Response;
  try {
    res = await fetch(sitePath(app.config, `${req.api === 'v1' ? '/api/v1' : APIPrefix}${req.path}`), {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        ...(method === 'GET' ? {} : {[HeaderIdempotencyKey]: uuid()}),
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
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
  return json as T | undefined;
}
