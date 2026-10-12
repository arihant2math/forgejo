// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// An independent replica checks convergence without trusting the app's applier.

import type {BootstrapEnd, BootstrapHeader, Change} from '../src/protocol/types.gen.ts';
import {ndjsonLines} from '../src/sync/ndjson.ts';
import {env} from './env.ts';
import {sleep} from './forgejo.ts';

export interface Loaded {
  status: number;
  header: BootstrapHeader;
  /** The group's own entity lines, then the profiles of other groups (their own g). */
  changes: Change[];
  end: BootstrapEnd;
  headers: Headers;
}

export class LoadError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`load: ${status} ${body}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * GET /-/sync/bootstrap (or /-/sync/load) of a group. Waits out the
 * entity-index gate (503 + Retry-After); other errors throw a LoadError.
 */
export async function load(token: string, group: string, o: {path?: 'bootstrap' | 'load'; models?: string[]; query?: Record<string, string>} = {}): Promise<Loaded> {
  const q = new URLSearchParams({group, ...o.query});
  if (o.models) q.set('model', o.models.join(','));
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await fetch(`${env.url}/-/sync/${o.path ?? 'bootstrap'}?${q.toString()}`, {headers: {Authorization: `Bearer ${token}`}});
    if (res.status === 503 && Date.now() < deadline) {
      await res.body?.cancel();
      await sleep(Number(res.headers.get('Retry-After') ?? '1') * 1000);
      continue;
    }
    if (!res.ok || !res.body) throw new LoadError(res.status, await res.text());
    return {status: res.status, headers: res.headers, ...await parseLoaded(res.body, group)};
  }
}

/** Requires one header, entity lines, and one final end line; malformed or truncated bodies throw. */
export async function parseLoaded(body: ReadableStream<Uint8Array>, group: string): Promise<{header: BootstrapHeader; changes: Change[]; end: BootstrapEnd}> {
  let header: BootstrapHeader | undefined;
  let end: BootstrapEnd | undefined;
  const changes: Change[] = [];
  for await (const lines of ndjsonLines(body)) {
    for (const line of lines) {
      const v = JSON.parse(line) as {type?: string};
      if (end) throw new Error(`load ${group}: data after the end line`);
      if (v.type === 'header') {
        if (header) throw new Error(`load ${group}: second header`);
        header = v as BootstrapHeader;
        if (header.group !== group) throw new Error(`load ${group}: header of ${header.group}`);
      } else if (v.type === 'end') {
        if (!header) throw new Error(`load ${group}: end line before the header`);
        end = v as BootstrapEnd;
      } else if (v.type !== undefined) {
        throw new Error(`load ${group}: unknown line type ${v.type}`);
      } else {
        if (!header) throw new Error(`load ${group}: entity before the header`);
        changes.push(v as Change);
      }
    }
  }
  if (!header || !end) throw new Error(`load ${group}: incomplete response (no ${header ? 'end line' : 'header'})`);
  return {header, changes, end};
}

interface Held {
  g: string;
  v: number;
  /** Undefined: deleted (a tombstone keeps the version). */
  d: unknown;
}

const key = (m: string, id: number) => `${m}:${id}`;

export class Replica {
  private readonly held = new Map<string, Held>();

  apply(c: Change): boolean {
    const k = key(c.m, c.id);
    const cur = this.held.get(k);
    if (cur && cur.v >= c.v) return false;
    this.held.set(k, {g: c.g, v: c.v, d: c.op === 'U' ? c.d : undefined});
    return true;
  }

  bootstrap(b: Loaded): void {
    const w = b.header.watermark;
    const got = new Set<string>();
    for (const c of b.changes) {
      const k = key(c.m, c.id);
      const cur = this.held.get(k);
      // Bootstrap state wins at or below its watermark, never over a newer delta.
      if (!cur || cur.v <= w) this.held.set(k, {g: c.g, v: w, d: c.d});
      if (c.g === b.header.group) got.add(k);
    }
    const models = b.header.models ? new Set(b.header.models) : undefined;
    for (const [k, h] of this.held) {
      const m = k.slice(0, k.indexOf(':'));
      if (h.g === b.header.group && h.v <= w && !got.has(k) && (!models || models.has(m))) this.held.delete(k);
    }
  }

  purge(group: string): void {
    for (const [k, h] of this.held) if (h.g === group) this.held.delete(k);
  }

  /** The live entities of a group: "Model:id" → payload. */
  state(group: string, model?: string): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const [k, h] of this.held) {
      if (h.g === group && h.d !== undefined && (!model || k.startsWith(`${model}:`))) out.set(k, h.d);
    }
    return out;
  }

  count(group: string): number {
    return this.state(group).size;
  }
}

/** What a fresh bootstrap holds of its group, as Replica.state does. */
export function stateOf(b: Loaded): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const c of b.changes) if (c.g === b.header.group) out.set(key(c.m, c.id), c.d);
  return out;
}
