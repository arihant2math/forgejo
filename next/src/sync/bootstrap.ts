// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Bootstraps and partial loads over HTTP (PLAN §4.7, protocol.BootstrapHeader):
// GET {endpoint}/bootstrap?group=G[&model=…] or {endpoint}/load?group=…
// stream NDJSON (header, entity lines, end). Lines are applied to the pool
// as they arrive, in one pool batch per network chunk; the replacement runs
// once the end line arrived. A response without an end line is incomplete:
// what it applied stays (every line is a real state at the watermark and
// went through the version check), the caller retries.

import {isModel} from '../data/models.ts';
import type {Pool} from '../data/pool.ts';
import type {BootstrapEnd, BootstrapHeader, Change} from '../protocol/types.gen.ts';
import {ndjsonLines} from './ndjson.ts';
import {replaceGroup} from './replace.ts';

export class HttpError extends Error {
  readonly status: number;
  /** Seconds, from Retry-After (503). */
  readonly retryAfter: number | undefined;

  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface LoadRequest {
  endpoint: string;
  token: string;
  group: string;
  /** `bootstrap` (default) or `load` (issue:{id}, closed pages). */
  kind?: 'bootstrap' | 'load';
  models?: readonly string[] | undefined;
  /** Closed tier page (load only). */
  closedBefore?: string | undefined;
  limit?: number;
  signal?: AbortSignal;
  /** Units the group is held with (replacement scope rule). */
  heldUnits: readonly string[] | undefined;
  /** The summary's closed_before the group is held with (closed pages). */
  summaryClosedBefore?: number | undefined;
  /** Called before each batch is applied; false stops applying (the group was released). */
  live?: () => boolean;
  fetch?: typeof fetch;
}

export interface LoadResult {
  header: BootstrapHeader;
  end: BootstrapEnd;
  /** Entities of the group the response contained. */
  count: number;
  /** Lines of other groups (embedded profiles). */
  embedded: number;
  dropped: number;
  bytes: number;
  ms: number;
}

export function loadURL(req: LoadRequest): string {
  const q = new URLSearchParams({group: req.group});
  if (req.models?.length) q.set('model', req.models.join(','));
  if (req.closedBefore !== undefined) q.set('closedBefore', req.closedBefore);
  if (req.limit !== undefined) q.set('limit', String(req.limit));
  return `${req.endpoint}/${req.kind ?? 'bootstrap'}?${q.toString()}`;
}

/** Fetches a bootstrap or load and applies it to the pool. */
export async function load(pool: Pool, req: LoadRequest): Promise<LoadResult> {
  const t0 = performance.now();
  const f = req.fetch ?? fetch;
  const init: RequestInit = {
    headers: {Authorization: `Bearer ${req.token}`, Accept: 'application/x-ndjson'},
    cache: 'no-store',
  };
  if (req.signal) init.signal = req.signal;
  const res = await f(loadURL(req), init);
  if (!res.ok || !res.body) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as {message?: string}).message ?? message;
    } catch {
      // Not JSON.
    }
    const ra = Number(res.headers.get('Retry-After'));
    throw new HttpError(res.status, message, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  let header: BootstrapHeader | undefined;
  // Profiles of other groups are applied only once the response is complete: an incomplete
  // response must not leave entities of groups nobody holds.
  const embedded: Change[] = [];
  let end: BootstrapEnd | undefined;
  const received = new Map<string, Set<number>>();
  let count = 0;
  let bytes = 0;
  const live = req.live ?? (() => true);
  for await (const lines of ndjsonLines(res.body)) {
    if (!live()) throw new DOMException('released', 'AbortError');
    if (end) throw new Error('bootstrap: data after the end line');
    const changes: Change[] = [];
    for (const line of lines) {
      bytes += line.length + 1;
      const obj = JSON.parse(line) as {type?: string};
      if (obj.type === 'header') {
        if (header) throw new Error('bootstrap: second header');
        header = obj as BootstrapHeader;
        if (header.group !== req.group) throw new Error(`bootstrap: header of ${header.group}, asked for ${req.group}`);
      } else if (obj.type === 'end') {
        if (end) throw new Error('bootstrap: second end line');
        end = obj as BootstrapEnd;
      } else {
        if (!header) throw new Error('bootstrap: entity before the header');
        if (end) throw new Error('bootstrap: data after the end line');
        const c = obj as Change;
        if (c.g === req.group) changes.push(c);
        else embedded.push(c);
      }
    }
    if (changes.length) {
      pool.batch(() => {
        for (const c of changes) {
          if (c.op !== 'U' || !isModel(c.m)) continue;
          count++;
          let ids = received.get(c.m);
          if (!ids) received.set(c.m, ids = new Set());
          ids.add(c.id);
          pool.put(c.m, c.id, c.g, c.v, c.d as never, true);
        }
      });
    }
  }
  if (!header || !end) throw new Error('bootstrap: incomplete response (no end line)');
  if (!live()) throw new DOMException('released', 'AbortError');
  pool.batch(() => {
    for (const c of embedded) if (c.op === 'U' && isModel(c.m)) pool.put(c.m, c.id, c.g, c.v, c.d as never);
  });
  const dropped = replaceGroup(pool, {
    group: req.group, header, end, received, heldUnits: req.heldUnits, summaryClosedBefore: req.summaryClosedBefore,
  });
  return {header, end, count, embedded: embedded.length, dropped, bytes, ms: performance.now() - t0};
}
