// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Write-behind persistence (leader tab only): the pool marks what changed;
// a flush writes those entities as they are *now* (or deletes them) plus the
// changed meta entries. Large flushes are split into transactions of
// CHUNK records so no single structured-clone pass blocks the main thread
// for long; the meta entries and the flush sequence go into the last one,
// so a crash in between leaves entities newer than the persisted positions
// (safe: they are replayed again), never the other way round.
//
// Every committed transaction is announced to follower tabs (`onCommit`)
// with the records it wrote, labelled with the flush sequence; followers
// mirror IndexedDB from that (see Pool.mirror).

import type {EntityRecord} from './entity.ts';
import {done, META, modelStore, writeTx} from './idb.ts';
import type {MetaCache} from './meta.ts';
import type {ModelName} from './models.ts';
import type {Pool} from './pool.ts';

/** What one committed transaction of a flush wrote. */
export interface Commit {
  seq: number;
  puts: [ModelName, EntityRecord[]][];
  dels: [ModelName, number[]][];
  /** Model stores emptied (before the puts). */
  cleared: ModelName[];
  /** The last transaction of the flush (meta and the sequence were written). */
  last: boolean;
}

export const CHUNK = 1000;
/** Debounce of a flush after a change. */
export const FLUSH_DELAY = 40;
/** A flush is not postponed longer than this under continuous changes. */
export const FLUSH_MAX_DELAY = 400;

export interface PersisterOptions {
  onCommit?: (c: Commit) => void;
  onError?: (err: unknown) => void;
  /** The last flush sequence persisted (meta "flushedSeq"). */
  seq?: number;
}

interface Op {
  m: ModelName;
  put?: EntityRecord;
  del?: number;
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
  /** Model stores to empty before the next writes (their schema changed). */
  private clears = new Set<ModelName>();

  constructor(db: IDBDatabase, pool: Pool, meta: MetaCache, opts: PersisterOptions = {}) {
    this.db = db;
    this.pool = pool;
    this.meta = meta;
    this.opts = opts;
    this.seq = opts.seq ?? 0;
  }

  /** The sequence of the last flush that committed. */
  get flushedSeq(): number {
    return this.seq;
  }

  /** Schedules a flush soon (debounced, bounded). */
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

  /**
   * Empties these model stores in the next flush, before anything else is
   * written (the pool dropped them already; a flush in progress may still
   * write old records, which the clear then removes).
   */
  clearModels(models: readonly ModelName[]): void {
    for (const m of models) this.clears.add(m);
    this.schedule();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async run(): Promise<void> {
    if (this.clears.size) {
      const clears = [...this.clears];
      this.clears = new Set();
      try {
        const tx = writeTx(this.db, clears.map(modelStore));
        for (const m of clears) tx.objectStore(modelStore(m)).clear();
        await done(tx);
        this.opts.onCommit?.({seq: this.seq + 1, puts: [], dels: [], cleared: clears, last: false});
      } catch (err) {
        for (const m of clears) this.clears.add(m);
        this.failures++;
        this.opts.onError?.(err);
        this.schedule();
        return;
      }
    }
    if (!this.pool.dirtyCount && !this.meta.isDirty) return;
    const dirty = this.pool.takeDirty();
    const meta = this.meta.takeDirty();
    const ops: Op[] = [];
    for (const [m, ids] of dirty) {
      const store = this.pool.stores[m];
      for (const id of ids.keys()) {
        const e = store._map.get(id);
        ops.push(e ? {m, put: e.record()} : {m, del: id});
      }
    }
    const seq = this.seq + 1;
    let i = 0;
    try {
      do {
        const chunk = ops.slice(i, i + CHUNK);
        i += CHUNK;
        const last = i >= ops.length;
        const names = new Set(chunk.map((o) => modelStore(o.m)));
        if (last) names.add(META);
        const tx = writeTx(this.db, [...names]);
        const puts = new Map<ModelName, EntityRecord[]>();
        const dels = new Map<ModelName, number[]>();
        for (const o of chunk) {
          const store = tx.objectStore(modelStore(o.m));
          if (o.put) {
            store.put(o.put);
            let l = puts.get(o.m);
            if (!l) puts.set(o.m, l = []);
            l.push(o.put);
          } else if (o.del !== undefined) {
            store.delete(o.del);
            let l = dels.get(o.m);
            if (!l) dels.set(o.m, l = []);
            l.push(o.del);
          }
        }
        if (last) {
          const ms = tx.objectStore(META);
          for (const [k, v] of meta) {
            if (v === undefined) ms.delete(k);
            else ms.put({k, v});
          }
          ms.put({k: 'flushedSeq', v: seq});
        }
        await done(tx);
        if (last) this.seq = seq;
        this.opts.onCommit?.({seq, puts: [...puts], dels: [...dels], cleared: [], last});
      } while (i < ops.length);
      this.failures = 0;
    } catch (err) {
      // Write everything again (idempotent): the entities as they are by then.
      this.pool.restoreDirty(dirty);
      this.meta.restoreDirty(meta);
      this.failures++;
      this.opts.onError?.(err);
      this.schedule();
    }
  }
}
