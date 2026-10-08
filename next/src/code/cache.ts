// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The code cache (PLAN §3, §5.5, §5.7): git content addressed by SHA —
// trees and files by (repository, commit, path), blobs, blames, diffs by
// (base, head), highlighted lines by blob SHA, finished job logs by job id —
// never goes stale, so it is kept until the quota budget pushes it out (LRU).
// Only the mutable ref → SHA step is decided elsewhere, from the synced
// Branch/Release entities (refs.ts).
//
// Two levels: a memory LRU (synchronous hits: switching to a file seen in
// this tab paints in the same frame) over the user's IndexedDB `blobs` store
// (F2 created it, keyPath `sha`, index `atime`). Each entry is two records:
//
//   d:<key>  {sha, v}                      the value (no atime: not in the index)
//   m:<key>  {sha, atime, size, repo}      what eviction reads (small)
//
// so eviction walks only the small records. Entries name their repository:
// a revoked repository's content is deleted with its group (purgeRepo), and
// the database is per user (deleted at sign-out), so nothing is shared
// between accounts. Writes may come from any tab (it is a cache: a lost
// write is a later miss).

import {BLOBS, done, request} from '../data/idb.ts';

export interface CacheMeta {
  key: string;
  atime: number;
  size: number;
  repo: number;
}

/**
 * The entries to delete so that the rest fits the budget: least recently used
 * first. Pure (cache.test.ts).
 */
export function toEvict(entries: readonly CacheMeta[], budget: number): string[] {
  let total = 0;
  for (const e of entries) total += e.size;
  if (total <= budget) return [];
  const out: string[] = [];
  const order = [...entries].sort((a, b) => a.atime - b.atime || (a.key < b.key ? -1 : 1));
  for (const e of order) {
    if (total <= budget) break;
    out.push(e.key);
    total -= e.size;
  }
  return out;
}

/** A size-bounded LRU map (Map keeps insertion order: a hit is moved to the end). */
export class MemoryLru<V> {
  private readonly map = new Map<string, {v: V; size: number}>();
  private total = 0;
  readonly budget: number;
  constructor(budget: number) {
    this.budget = budget;
  }

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, v: V, size: number): void {
    const old = this.map.get(key);
    if (old) {
      this.total -= old.size;
      this.map.delete(key);
    }
    // Larger than the whole budget: not kept (it would push everything out).
    if (size > this.budget) return;
    this.map.set(key, {v, size});
    this.total += size;
    for (const [k, e] of this.map) {
      if (this.total <= this.budget) break;
      this.map.delete(k);
      this.total -= e.size;
    }
  }

  delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.total -= e.size;
    this.map.delete(key);
  }

  deleteWhere(pred: (key: string) => boolean): void {
    for (const k of [...this.map.keys()]) if (pred(k)) this.delete(k);
  }

  get size(): number {
    return this.total;
  }
}

/** Approximate bytes of a value (strings as UTF-16, typed arrays by length, the rest by its JSON). */
export function sizeOf(v: unknown): number {
  if (typeof v === 'string') return v.length * 2;
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v.byteLength;
  if (v && typeof v === 'object') {
    let n = 0;
    for (const x of Object.values(v as Record<string, unknown>)) n += sizeOf(x) + 16;
    if (Array.isArray(v)) return n + 16;
    return n;
  }
  return 8;
}

const MB = 1024 * 1024;
/** IndexedDB budget bounds: a tenth of the origin's quota, within these. */
const MIN_BUDGET = 64 * MB;
const MAX_BUDGET = 512 * MB;
/** atime is written back at most this often per entry (a hit is a read, not a write). */
const TOUCH_EVERY = 60_000;

/** The repository id of a cache key ("kind:<repo>:…"). */
export function keyRepo(key: string): number {
  const a = key.indexOf(':');
  const b = key.indexOf(':', a + 1);
  return Number(key.slice(a + 1, b < 0 ? undefined : b)) || 0;
}

export interface CodeCacheOptions {
  /** Bytes kept in IndexedDB (default: a tenth of the quota, 64–512 MB). */
  budget?: number;
  /** Bytes kept in memory (default 48 MB). */
  memory?: number;
  now?: () => number;
}

export class CodeCache {
  private readonly mem: MemoryLru<unknown>;
  private readonly now: () => number;
  private budget: number | undefined;
  private readonly touched = new Map<string, number>();
  private evictTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly db: IDBDatabase;
  /** Repositories purged this session (see put). */
  private readonly revoked = new Set<number>();

  constructor(db: IDBDatabase, opts: CodeCacheOptions = {}) {
    this.db = db;
    this.mem = new MemoryLru(opts.memory ?? 48 * MB);
    this.now = opts.now ?? Date.now;
    this.budget = opts.budget;
  }

  /** A value from memory only (synchronous: the first frame of a view). */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names what it stored under the key
  peek<T>(key: string): T | undefined {
    return this.mem.get(key) as T | undefined;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.mem.get(key);
    if (hit !== undefined) {
      this.touch(key);
      return hit as T;
    }
    if (this.closed) return undefined;
    let rec: {v: T} | undefined;
    try {
      rec = await request(this.db.transaction(BLOBS, 'readonly').objectStore(BLOBS).get(`d:${key}`) as IDBRequest<{v: T} | undefined>);
    } catch {
      return undefined; // a closed or failing database is a miss
    }
    if (!rec) return undefined;
    this.mem.set(key, rec.v, sizeOf(rec.v));
    this.touch(key);
    return rec.v;
  }

  /** Keeps a value in memory only (this session: recomputable, or not worth storing). */
  remember(key: string, v: unknown, size = sizeOf(v)): void {
    if (this.revoked.has(keyRepo(key))) return;
    this.mem.set(key, v, size);
  }

  /** Whether an entry is stored (its small metadata record only: the value is not read). */
  async has(key: string): Promise<boolean> {
    if (this.mem.has(key)) return true;
    if (this.closed) return false;
    try {
      return await request(this.db.transaction(BLOBS, 'readonly').objectStore(BLOBS).count(`m:${key}`)) > 0;
    } catch {
      return false;
    }
  }

  /** Stores a value (memory at once, IndexedDB in the background). Only immutable content, or a hint that says so. */
  put(key: string, v: unknown, size = sizeOf(v)): void {
    // A request that was running when the repository was revoked does not put its answer back.
    if (this.revoked.has(keyRepo(key))) return;
    this.mem.set(key, v, size);
    if (this.closed) return;
    const at = this.now();
    this.touched.set(key, at);
    try {
      const tx = this.db.transaction(BLOBS, 'readwrite', {durability: 'relaxed'});
      const s = tx.objectStore(BLOBS);
      s.put({sha: `d:${key}`, v});
      s.put({sha: `m:${key}`, atime: at, size, repo: keyRepo(key)});
      done(tx).then(() => {
        this.scheduleEvict();
      }, () => undefined);
    } catch {
      // Quota or a closed database: the memory copy still serves this tab.
    }
  }

  /** Forgets one entry (a mutable hint replaced). */
  delete(key: string): void {
    this.mem.delete(key);
    void this.deleteKeys([key]);
  }

  private touch(key: string): void {
    const at = this.now();
    if (at - (this.touched.get(key) ?? 0) < TOUCH_EVERY || this.closed) return;
    this.touched.set(key, at);
    try {
      const tx = this.db.transaction(BLOBS, 'readwrite', {durability: 'relaxed'});
      const s = tx.objectStore(BLOBS);
      const r = s.get(`m:${key}`) as IDBRequest<{sha: string; atime: number} | undefined>;
      r.onsuccess = () => {
        if (r.result) s.put({...r.result, atime: at});
      };
    } catch {
      // ignore
    }
  }

  /** Every entry's metadata (the small records only). */
  async entries(): Promise<CacheMeta[]> {
    const tx = this.db.transaction(BLOBS, 'readonly');
    const all = await request(tx.objectStore(BLOBS).index('atime').getAll() as IDBRequest<{sha: string; atime: number; size: number; repo: number}[]>);
    return all.map((r) => ({key: r.sha.slice(2), atime: r.atime, size: r.size, repo: r.repo}));
  }

  private scheduleEvict(): void {
    if (this.evictTimer !== undefined || this.closed) return;
    this.evictTimer = setTimeout(() => {
      this.evictTimer = undefined;
      void this.evict().catch(() => undefined);
    }, 2000);
  }

  private async limit(): Promise<number> {
    if (this.budget !== undefined) return this.budget;
    let quota = 0;
    try {
      quota = (await navigator.storage.estimate()).quota ?? 0;
    } catch {
      // no Storage API
    }
    this.budget = Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, quota / 10));
    return this.budget;
  }

  /** Deletes least recently used entries beyond the budget. */
  async evict(): Promise<number> {
    if (this.closed) return 0;
    const keys = toEvict(await this.entries(), await this.limit());
    await this.deleteKeys(keys);
    return keys.length;
  }

  /** Deletes everything of a repository (its group was revoked: the viewer may no longer read it). */
  async purgeRepo(repoId: number): Promise<void> {
    this.revoked.add(repoId);
    this.mem.deleteWhere((k) => keyRepo(k) === repoId);
    if (this.closed) return;
    const keys = (await this.entries()).filter((e) => e.repo === repoId).map((e) => e.key);
    await this.deleteKeys(keys);
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    if (!keys.length || this.closed) return;
    for (const k of keys) this.mem.delete(k);
    try {
      const tx = this.db.transaction(BLOBS, 'readwrite');
      const s = tx.objectStore(BLOBS);
      for (const k of keys) {
        s.delete(`d:${k}`);
        s.delete(`m:${k}`);
        this.touched.delete(k);
      }
      await done(tx);
    } catch {
      // A later eviction retries.
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.evictTimer);
  }
}
