// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Immutable content lives in a memory LRU over per-user IndexedDB.
// Separate d:<key> values and m:<key> metadata keep eviction scans small.
// Repository keys allow revocation purges; sign-out deletes the database.

import {BLOBS, done, request} from '../data/idb.ts';

export interface CacheMeta {
  key: string;
  atime: number;
  size: number;
  repo: number;
}

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

/** Approximate bytes: UTF-16 strings, buffer byte lengths, recursive object sizes. */
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
  private readonly revoked = new Set<number>();

  constructor(db: IDBDatabase, opts: CodeCacheOptions = {}) {
    this.db = db;
    this.mem = new MemoryLru(opts.memory ?? 48 * MB);
    this.now = opts.now ?? Date.now;
    this.budget = opts.budget;
  }

  /** A value from memory only (synchronous: the first frame of a view). */
  peek<T>(key: string): T | undefined {
    return this.mem.get(key) as T | undefined;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.mem.get(key);
    if (hit !== undefined) {
      this.touch([key]);
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
    this.touch([key]);
    return rec.v;
  }

  /** Several values, the ones not in memory read in one transaction. */
  async getMany<T>(keys: readonly string[]): Promise<(T | undefined)[]> {
    const out = keys.map((k) => this.mem.get(k) as T | undefined);
    const missing = keys.filter((_, i) => out[i] === undefined);
    if (missing.length && !this.closed) {
      try {
        const store = this.db.transaction(BLOBS, 'readonly').objectStore(BLOBS);
        const recs = await Promise.all(missing.map((k) => request(store.get(`d:${k}`) as IDBRequest<{v: T} | undefined>)));
        const found = new Map<string, T>();
        missing.forEach((k, i) => {
          const rec = recs[i];
          if (!rec) return;
          found.set(k, rec.v);
          this.mem.set(k, rec.v, sizeOf(rec.v));
        });
        keys.forEach((k, i) => {
          out[i] ??= found.get(k);
        });
      } catch {
        // A closed or failing database: misses.
      }
    }
    this.touch(keys.filter((_, i) => out[i] !== undefined));
    return out;
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
    this.putMany([[key, v, size]]);
  }

  /** Stores several values in one transaction. */
  putMany(entries: readonly (readonly [key: string, v: unknown, size?: number])[]): void {
    // In-flight requests must not restore revoked content.
    const kept = entries.filter(([key]) => !this.revoked.has(keyRepo(key))).map(([key, v, size]) => [key, v, size ?? sizeOf(v)] as const);
    for (const [key, v, size] of kept) this.mem.set(key, v, size);
    if (this.closed || !kept.length) return;
    const at = this.now();
    try {
      const tx = this.db.transaction(BLOBS, 'readwrite', {durability: 'relaxed'});
      const s = tx.objectStore(BLOBS);
      for (const [key, v, size] of kept) {
        this.touched.set(key, at);
        s.put({sha: `d:${key}`, v});
        s.put({sha: `m:${key}`, atime: at, size, repo: keyRepo(key)});
      }
      done(tx).then(() => {
        this.scheduleEvict();
      }, () => undefined);
    } catch {
      // Quota or a closed database: the memory copy still serves this tab.
    }
  }

  delete(key: string): void {
    this.mem.delete(key);
    void this.deleteKeys([key]);
  }

  private touch(keys: readonly string[]): void {
    const at = this.now();
    const due = keys.filter((k) => at - (this.touched.get(k) ?? 0) >= TOUCH_EVERY);
    if (!due.length || this.closed) return;
    try {
      const tx = this.db.transaction(BLOBS, 'readwrite', {durability: 'relaxed'});
      const s = tx.objectStore(BLOBS);
      for (const key of due) {
        this.touched.set(key, at);
        const r = s.get(`m:${key}`) as IDBRequest<{sha: string; atime: number} | undefined>;
        r.onsuccess = () => {
          if (r.result) s.put({...r.result, atime: at});
        };
      }
    } catch {
      // Access-time updates are best-effort.
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

  async evict(): Promise<number> {
    if (this.closed) return 0;
    const keys = toEvict(await this.entries(), await this.limit());
    await this.deleteKeys(keys);
    return keys.length;
  }

  /** Purges repository content and rejects subsequent writes for this session. */
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
