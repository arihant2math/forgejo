// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Leader-only write-behind persistence splits flushes to limit main-thread cloning work.
// Meta and flushedSeq commit last: a crash may leave replayable newer entities, never newer positions.
// Each committed chunk is announced to followers for IndexedDB mirroring.

import type {EntityRecord} from './entity.ts';
import {done, META, modelStore, writeTx} from './idb.ts';
import {canHold, groupKind, MODEL_NAMES} from './models.ts';
import type {MetaCache} from './meta.ts';
import type {ModelName} from './models.ts';
import {type DirtyBuckets, MAX_BUCKETS, type ModelStore, type Pool} from './pool.ts';

/** A bucket as written: its records (none: the bucket was deleted). */
export interface BucketWrite {
  m: ModelName;
  g: string;
  b: number;
  r: EntityRecord[];
}

export interface Commit {
  seq: number;
  buckets: BucketWrite[];
  /** Model stores emptied (before the puts). */
  cleared: ModelName[];
  /** Groups whose every bucket was deleted (before the puts). */
  dropped: string[];
  /** The last transaction of the flush (meta and the sequence were written). */
  last: boolean;
}

/** Records per transaction (a bucket is never split). */
export const CHUNK = 5000;
/** Values per transaction (many small buckets cost per value). */
export const CHUNK_VALUES = 500;
/** Flush debounce in milliseconds. */
export const FLUSH_DELAY = 40;
/** Maximum debounce in milliseconds under continuous changes. */
export const FLUSH_MAX_DELAY = 400;

export interface PersisterOptions {
  onCommit?: (c: Commit) => void;
  onError?: (err: unknown) => void;
  /** The last flush sequence persisted (meta "flushedSeq"). */
  seq?: number;
  /** Defers group records and meta, keeping them dirty to avoid partial-bucket data loss.
   * Call schedule() when a group is ready to persist.
   */
  defer?: (group: string) => boolean;
  /** The IDBKeyRange of the factory that opened the database (default: the global one). */
  keyRange?: typeof IDBKeyRange;
}

export class Persister {
  private readonly db: IDBDatabase;
  private readonly pool: Pool;
  private readonly meta: MetaCache;
  private readonly opts: PersisterOptions;
  private seq: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstPending = 0;
  private running: Promise<void> | undefined;
  private failures = 0;
  private closed = false;
  private clears = new Set<ModelName>();
  private drops = new Set<string>();

  constructor(db: IDBDatabase, pool: Pool, meta: MetaCache, opts: PersisterOptions = {}) {
    this.db = db;
    this.pool = pool;
    this.meta = meta;
    this.opts = opts;
    this.seq = opts.seq ?? 0;
  }

  get flushedSeq(): number {
    return this.seq;
  }

  schedule(): void {
    if (this.closed) return;
    const now = Date.now();
    if (this.timer === undefined) this.firstPending = now;
    else clearTimeout(this.timer);
    // After failures (e.g. quota), back off up to 30 s.
    const wait = this.failures ?
      Math.min(30_000, FLUSH_DELAY * 2 ** this.failures) :
      Math.max(0, Math.min(FLUSH_DELAY, this.firstPending + FLUSH_MAX_DELAY - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, wait);
  }

  /** Flushes now and resolves once everything changed before the call is persisted. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // A flush in progress took its work list before this call: wait for it, then run (or join) the next one.
    if (this.running) await this.running;
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    await this.running;
  }

  /** Clears before the next writes, removing stale records from any in-flight flush. */
  clearModels(models: readonly ModelName[]): void {
    for (const m of models) this.clears.add(m);
    this.schedule();
  }

  /** Drops whole groups, including persisted records the pool has not hydrated. */
  dropGroups(groups: readonly string[]): void {
    for (const g of groups) this.drops.add(g);
    this.schedule();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async run(): Promise<void> {
    if (this.clears.size || this.drops.size) {
      const clears = [...this.clears];
      const drops = [...this.drops];
      this.clears = new Set();
      this.drops = new Set();
      try {
        const tx = writeTx(this.db, [...MODEL_NAMES.map(modelStore), META]);
        // Drop records and position claims atomically; replacement state stays dirty until its records can commit.
        for (const g of drops) {
          const k = `group:${g}`;
          const v = this.meta.get<Record<string, unknown>>(k);
          if (v === undefined) {
            tx.objectStore(META).delete(k);
            continue;
          }
          const {position: _p, watermark: _w, units: _u, closedBefore: _c, tier: _t, ...rest} = v;
          tx.objectStore(META).put({k, v: {...rest, needs: {all: true, models: [], reason: 'dropped'}}});
        }
        for (const m of clears) tx.objectStore(modelStore(m)).clear();
        for (const g of drops) {
          const kind = groupKind(g);
          for (const m of MODEL_NAMES) {
            if (kind && canHold(kind, m)) tx.objectStore(modelStore(m)).delete((this.opts.keyRange ?? IDBKeyRange).bound([g, 0], [g, MAX_BUCKETS]));
          }
        }
        await done(tx);
        this.opts.onCommit?.({seq: this.seq + 1, buckets: [], cleared: clears, dropped: drops, last: false});
      } catch (err) {
        for (const m of clears) this.clears.add(m);
        for (const g of drops) this.drops.add(g);
        this.failures++;
        this.opts.onError?.(err);
        this.schedule();
        return;
      }
    }
    if (!this.pool.dirtyCount && !this.meta.isDirty) return;
    const dirty = this.pool.takeDirty();
    const meta = this.meta.takeDirty();
    const defer = this.opts.defer;
    if (defer) {
      const later: DirtyBuckets = new Map();
      for (const [m, groups] of dirty) {
        for (const [g, bs] of groups) {
          if (!defer(g)) continue;
          groups.delete(g);
          let lg = later.get(m);
          if (!lg) later.set(m, lg = new Map<string, Set<number>>());
          lg.set(g, bs);
        }
      }
      if (later.size) this.pool.restoreDirty(later);
      const laterMeta = new Map<string, unknown>();
      for (const [k, v] of meta) {
        if (k.startsWith('group:') && defer(k.slice('group:'.length))) {
          meta.delete(k);
          laterMeta.set(k, v);
        }
      }
      if (laterMeta.size) this.meta.restoreDirty(laterMeta);
    }
    if (!meta.size && ![...dirty.values()].some((groups) => groups.size)) return;
    const writes: BucketWrite[] = [];
    for (const [m, groups] of dirty) {
      const store: ModelStore = this.pool.stores[m];
      for (const [g, bs] of groups) {
        for (const b of bs) {
          const r: EntityRecord[] = [];
          for (const e of store._slot(g, b)) r.push(e.record());
          writes.push({m, g, b, r});
        }
      }
    }
    const seq = this.seq + 1;
    let i = 0;
    try {
      do {
        const chunk: BucketWrite[] = [];
        let n = 0;
        while (i < writes.length && chunk.length < CHUNK_VALUES && (n === 0 || n + (writes[i]?.r.length ?? 0) <= CHUNK)) {
          const w = writes[i++];
          if (!w) break;
          chunk.push(w);
          n += Math.max(1, w.r.length);
        }
        const last = i >= writes.length;
        const names = new Set(chunk.map((w) => modelStore(w.m)));
        if (last) names.add(META);
        const tx = writeTx(this.db, [...names]);
        try {
          for (const w of chunk) {
            const store = tx.objectStore(modelStore(w.m));
            if (w.r.length) store.put({g: w.g, b: w.b, r: w.r});
            else store.delete([w.g, w.b]);
          }
          if (last) {
            const ms = tx.objectStore(META);
            for (const [k, v] of meta) {
              if (v === undefined) ms.delete(k);
              else ms.put({k, v});
            }
            ms.put({k: 'flushedSeq', v: seq});
          }
        } catch (err) {
          // A request that throws (e.g. DataCloneError) does not abort the transaction by itself.
          tx.abort();
          throw err;
        }
        await done(tx);
        if (last) this.seq = seq;
        this.opts.onCommit?.({seq, buckets: chunk, cleared: [], dropped: [], last});
      } while (i < writes.length);
      this.failures = 0;
    } catch (err) {
      this.pool.restoreDirty(dirty);
      this.meta.restoreDirty(meta);
      this.failures++;
      this.opts.onError?.(err);
      this.schedule();
    }
  }
}
