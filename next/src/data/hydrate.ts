// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Hydration (PLAN §5.2 step 2): IndexedDB → pool, in two phases.
//
//   1. `groups(list)`: the given groups in full, read through each model
//      store's group index in one transaction (the structure groups and the
//      current route's repository and issue). This is what the first frame
//      needs.
//   2. `rest()`: every store, in primary-key chunks of HYDRATE_CHUNK bucket
//      values, one transaction per chunk, yielding to the browser between
//      chunks (idle time unless `eager`). Buckets of groups phase 1 already
//      read are skipped.
//
// A group is one key range of a model store (keys are [group, bucket],
// see idb.ts), so phase 1 needs no index.
//
// Each read transaction also reads meta "flushedSeq": the records it returns
// are at least as new as that flush. Followers use the label to order reads
// against flush notifications (Pool.mirror); the leader loads through the
// version check (Pool.load). Records are taken over as they come out of
// IndexedDB (no copy): `d` becomes the entity's state.

import type {EntityRecord} from './entity.ts';
import {type BucketValue, META, modelStore, request} from './idb.ts';
import {canHold, groupKind, MODEL_NAMES, type ModelName} from './models.ts';
import {BUCKETS} from './pool.ts';

/** Bucket values per read transaction of phase 2. */
export const HYDRATE_CHUNK = 64;

/** Receives records read with the flush sequence they are at least as new as. */
export type Sink = (m: ModelName, records: EntityRecord[], seq: number) => void;

export interface HydrateStats {
  records: number;
  ms: number;
}

function flushedSeq(tx: IDBTransaction): Promise<number> {
  return request(tx.objectStore(META).get('flushedSeq') as IDBRequest<{v: number} | undefined>).then((r) => r?.v ?? 0);
}

/** Yields to the browser: an idle period, or a macrotask. */
export function yieldToBrowser(idle: boolean): Promise<void> {
  return new Promise((resolve) => {
    if (idle && typeof requestIdleCallback === 'function') requestIdleCallback(() => {
      resolve();
    }, {timeout: 200});
    else setTimeout(resolve, 0);
  });
}

export class Hydrator {
  private readonly db: IDBDatabase;
  private readonly sink: Sink;
  /** Groups read completely (phase 1, or `ensure`). */
  readonly hydrated = new Set<string>();
  private restDone = false;
  private restRunning: Promise<HydrateStats> | undefined;
  /** Phase 2 stops waiting for idle periods. */
  eager = false;
  /** The entities seen per model (followers reconcile with it; see Pool.retainSeen). */
  readonly seen = new Map<ModelName, Set<number>>();
  private minSeq = Number.POSITIVE_INFINITY;
  trackSeen = false;

  private readonly range: typeof IDBKeyRange;

  /** `keyRange`: the IDBKeyRange of the factory that opened `db` (default: the global one). */
  constructor(db: IDBDatabase, sink: Sink, keyRange: typeof IDBKeyRange = IDBKeyRange) {
    this.db = db;
    this.sink = sink;
    this.range = keyRange;
  }

  get complete(): boolean {
    return this.restDone;
  }

  /** The oldest flush any read so far was at. */
  get oldestSeq(): number {
    return this.minSeq === Number.POSITIVE_INFINITY ? 0 : this.minSeq;
  }

  /** Phase 1: reads the groups (that were not read yet) in one transaction. */
  async groups(list: Iterable<string>): Promise<HydrateStats> {
    const t0 = performance.now();
    const todo = [...new Set(list)].filter((g) => !this.hydrated.has(g) && groupKind(g) !== undefined);
    if (!todo.length || this.restDone) return {records: 0, ms: 0};
    const models = new Set<ModelName>();
    const reqs: [ModelName, string][] = [];
    for (const g of todo) {
      const kind = groupKind(g);
      if (!kind) continue;
      for (const m of MODEL_NAMES) {
        if (!canHold(kind, m)) continue;
        models.add(m);
        reqs.push([m, g]);
      }
    }
    const tx = this.db.transaction([META, ...[...models].map(modelStore)], 'readonly');
    const seqP = flushedSeq(tx);
    const results = await Promise.all(reqs.map(async ([m, g]) => {
      const values = await request(tx.objectStore(modelStore(m)).getAll(this.range.bound([g, 0], [g, BUCKETS])) as IDBRequest<BucketValue[]>);
      return values.flatMap((v) => v.r);
    }));
    const seq = await seqP;
    let records = 0;
    // Mark first: a concurrent phase 2 chunk must skip them from now on.
    for (const g of todo) this.hydrated.add(g);
    results.forEach((recs, i) => {
      const r = reqs[i];
      if (!r || !recs.length) return;
      records += recs.length;
      this.deliver(r[0], recs, seq);
    });
    return {records, ms: performance.now() - t0};
  }

  /** Phase 2: every store, chunked. Resolves when everything is loaded; runs once. */
  rest(): Promise<HydrateStats> {
    this.restRunning ??= this.runRest(true);
    return this.restRunning;
  }

  /** Reads everything again, skipping nothing (a follower taking over). */
  rereadAll(): Promise<HydrateStats> {
    this.seen.clear();
    this.minSeq = Number.POSITIVE_INFINITY;
    return this.runRest(false);
  }

  private async runRest(skipHydrated: boolean): Promise<HydrateStats> {
    const t0 = performance.now();
    let records = 0;
    for (const m of MODEL_NAMES) {
      let after: IDBValidKey | undefined;
      for (;;) {
        await yieldToBrowser(!this.eager);
        const tx = this.db.transaction([META, modelStore(m)], 'readonly');
        const seqP = flushedSeq(tx);
        const range = after === undefined ? null : this.range.lowerBound(after, true);
        const values = await request(tx.objectStore(modelStore(m)).getAll(range, HYDRATE_CHUNK) as IDBRequest<BucketValue[]>);
        const seq = await seqP;
        const last = values.at(-1);
        if (!last) break;
        after = [last.g, last.b];
        const recs: EntityRecord[] = [];
        for (const v of values) {
          if (skipHydrated && this.hydrated.has(v.g)) continue;
          for (const r of v.r) recs.push(r);
        }
        records += recs.length;
        if (recs.length) this.deliver(m, recs, seq);
        if (values.length < HYDRATE_CHUNK) break;
      }
    }
    this.restDone = true;
    return {records, ms: performance.now() - t0};
  }

  private deliver(m: ModelName, recs: EntityRecord[], seq: number): void {
    if (this.trackSeen) {
      let ids = this.seen.get(m);
      if (!ids) this.seen.set(m, ids = new Set());
      for (const r of recs) ids.add(r.id);
      if (seq < this.minSeq) this.minSeq = seq;
    }
    this.sink(m, recs, seq);
  }
}
