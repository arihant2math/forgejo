// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The object pool (PLAN §5.1, §5.3): every synced entity in memory, one
// ModelStore per model, with reactive lookups by id, by indexed field and
// over the whole store. The UI reads only from here.
//
// The pool is also the delta applier. Its write primitives are the rules
// every source of state goes through — deltas, replays, bootstraps, partial
// loads and IndexedDB hydration — and they make the result independent of
// the order and multiplicity in which those arrive (fuzzed in pool.test.ts):
//
//   put(m, id, g, v, d)   keep the state only if v is newer than what is held
//                         (versions are sync ids, global and monotonic);
//   del(m, id, g, v)      the entity left group g at v: drop it if what is
//                         held is older than v;
//   evict(m, id, g, maxV) the entity is not in group g as of maxV (bootstrap
//                         replacement, revocation): drop it if it is held in g
//                         at or below maxV.
//
// A delete or eviction leaves a tombstone (m, id, g) → v so that an older
// state of the entity in that group arriving later (an overlapping
// bootstrap, a duplicated or reordered frame) cannot bring it back.
// Tombstones are scoped to the group: "not in g at v" says nothing about
// other groups, so a move (D in g1, U in g2) converges in either order.
// A completed bootstrap of a group at watermark W leaves a group floor
// (`setFloor`): every entity of the group as of W is in the response, so any
// state of the group at or below W that is not held is stale — e.g. a
// profile embedded in an older bootstrap of another group — except what the
// bootstrap's scope leaves out (the closed tier, see sync/replace.ts).
// Group purges (`purgeGroup`) leave a group-wide floor too. Tombstones and
// floors live in memory only: after a reload no message from before it can
// arrive.

import {_isComputingDerivation, createAtom, type IAtom, runInAction} from 'mobx';
import {Entity, type EntityRecord, observeLazy} from './entity.ts';
import {type GroupKind, groupKind, MODEL_NAMES, MODELS, type ModelDefs, type ModelName, type ModelTypes} from './models.ts';

/** The fields a model is indexed on in the pool. */
export type IndexedField<M extends ModelName> =
  ModelDefs[M] extends {index: readonly (infer F)[]} ? F & keyof ModelTypes[M] & string : never;

interface Bucket<M extends ModelName> {
  set: Set<Entity<M>>;
  /** Created when the bucket is first observed. */
  atoms: Map<0, IAtom> | undefined;
}

const EMPTY: ReadonlySet<never> = new Set();

/** States of a group at or below a bootstrap's watermark are stale (see setFloor). */
interface Floor {
  all: number;
  models: Map<string, number>;
  /** States the bootstrap's scope leaves out (they may be newer than what is held). */
  exempt: ((m: ModelName, d: unknown) => boolean) | undefined;
}

export class ModelStore<M extends ModelName = ModelName> {
  readonly model: M;
  /** @internal */
  readonly _map = new Map<number, Entity<M>>();
  private readonly existence = new Map<number, IAtom>();
  private readonly membership = createAtom('pool');
  private readonly indexes = new Map<string, Map<unknown, Bucket<M>>>();
  private readonly fields: readonly string[];
  /** Group → persistence bucket → entities (what one IndexedDB value holds, see idb.ts). */
  private readonly slots = new Map<string, Map<number, Set<Entity<M>>>>();

  constructor(model: M) {
    this.model = model;
    const def: {index?: readonly string[]} = MODELS[model];
    this.fields = def.index ?? [];
    for (const f of this.fields) this.indexes.set(f, new Map());
  }

  /** The entity with this id; observing it reacts to its arrival or removal (not to its fields). */
  get(id: number): Entity<M> | undefined {
    observeLazy(this.existence, id);
    return this._map.get(id);
  }

  /** The number of entities; observing it reacts to arrivals and removals. */
  get size(): number {
    this.membership.reportObserved();
    return this._map.size;
  }

  /** Every entity of the model; observing it reacts to arrivals and removals. */
  all(): IterableIterator<Entity<M>> {
    this.membership.reportObserved();
    return this._map.values();
  }

  /**
   * The entities whose indexed `field` equals `value` (a live set: do not keep
   * it across reactions). Observing it reacts when entities enter or leave
   * the set, not to their other fields.
   */
  by<K extends IndexedField<M>>(field: K, value: ModelTypes[M][K]): ReadonlySet<Entity<M>> {
    const index = this.indexes.get(field);
    if (!index) throw new Error(`${this.model}.${field} is not indexed`);
    let bucket = index.get(value);
    if (!bucket) {
      // Created for the observer only; dropped again once nothing observes it and it is empty.
      bucket = {set: new Set(), atoms: undefined};
      index.set(value, bucket);
    }
    const b = bucket;
    if (_isComputingDerivation()) {
      const atoms = b.atoms ??= new Map<0, IAtom>();
      observeLazy(atoms, 0, () => {
        if (b.set.size === 0 && atoms.size === 0 && index.get(value) === b) index.delete(value);
      });
    }
    if (b.set.size === 0 && !b.atoms?.size) index.delete(value);
    return b.set;
  }

  /** @internal The entities of one persistence bucket of a group. */
  _slot(g: string, b: number): ReadonlySet<Entity<M>> {
    return this.slots.get(g)?.get(b) ?? EMPTY;
  }

  /** @internal The persistence buckets of a group that hold entities. */
  _slots(g: string): IterableIterator<number> {
    return (this.slots.get(g) ?? new Map<number, unknown>()).keys();
  }

  /** @internal */
  _slotAdd(g: string, e: Entity<M>): void {
    let byB = this.slots.get(g);
    if (!byB) this.slots.set(g, byB = new Map<number, Set<Entity<M>>>());
    const b = bucketOf(g, e.id);
    let set = byB.get(b);
    if (!set) byB.set(b, set = new Set());
    set.add(e);
  }

  /** @internal */
  _slotRemove(g: string, e: Entity<M>): void {
    const byB = this.slots.get(g);
    const b = bucketOf(g, e.id);
    const set = byB?.get(b);
    if (!byB || !set) return;
    set.delete(e);
    if (!set.size) byB.delete(b);
    if (!byB.size) this.slots.delete(g);
  }

  /** @internal */
  _insert(e: Entity<M>): void {
    this._map.set(e.id, e);
    for (const f of this.fields) this.bucketAdd(f, e._d[f as keyof ModelTypes[M]], e);
    this.existence.get(e.id)?.reportChanged();
    this.membership.reportChanged();
  }

  /** @internal */
  _delete(e: Entity<M>): void {
    this._map.delete(e.id);
    for (const f of this.fields) this.bucketRemove(f, e._d[f as keyof ModelTypes[M]], e);
    this.existence.get(e.id)?.reportChanged();
    this.membership.reportChanged();
  }

  /** @internal Moves `e` between buckets after its state changed from `old`. */
  _reindex(e: Entity<M>, old: ModelTypes[M]): void {
    for (const f of this.fields) {
      const k = f as keyof ModelTypes[M];
      const a = old[k];
      const b = e._d[k];
      if (a === b) continue;
      this.bucketRemove(f, a, e);
      this.bucketAdd(f, b, e);
    }
  }

  private bucketAdd(field: string, value: unknown, e: Entity<M>): void {
    const index = this.indexes.get(field);
    if (!index) return;
    let bucket = index.get(value);
    if (!bucket) {
      bucket = {set: new Set(), atoms: undefined};
      index.set(value, bucket);
    }
    bucket.set.add(e);
    bucket.atoms?.get(0)?.reportChanged();
  }

  private bucketRemove(field: string, value: unknown, e: Entity<M>): void {
    const bucket = this.indexes.get(field)?.get(value);
    if (!bucket) return;
    bucket.set.delete(e);
    bucket.atoms?.get(0)?.reportChanged();
    if (bucket.set.size === 0 && !bucket.atoms?.size) this.indexes.get(field)?.delete(value);
  }
}

/** Per model: the follower's flush sequence of each entity. */
type IdMap<T> = Map<ModelName, Map<number, T>>;

/** Per model, per group: the persistence buckets whose content changed. */
export type DirtyBuckets = Map<ModelName, Map<string, Set<number>>>;

/**
 * Entities are persisted in buckets: one IndexedDB value per (model, group,
 * id mod the group kind's bucket count). Writing one value of many records is
 * ~30× cheaper per record in Chromium than one value per record (see idb.ts),
 * while a change rewrites only its bucket. The counts keep values at tens to
 * a few thousand records for typical group sizes: a repository's 50 000
 * issues are 32 values of ~1600, an issue's 60 comments 2 values of 30.
 * Changing a count changes where records live: bump IDB_VERSION and drop the
 * model stores (idb.ts) when you do.
 */
const KIND_BUCKETS: Record<GroupKind, number> = {repo: 32, profiles: 32, user: 8, org: 8, owner: 4, profile: 2, issue: 2};

/** Upper bound of every bucket number (key ranges over a whole group). */
export const MAX_BUCKETS = 1024;

export function bucketOf(g: string, id: number): number {
  const kind = groupKind(g);
  const n = kind ? KIND_BUCKETS[kind] : 1;
  return ((id % n) + n) % n;
}

/** The maximum number of tombstones kept; the oldest go first. */
export const MAX_TOMBSTONES = 50_000;

/** A change the pool applied, as reported to `onApplied` listeners. */
export interface Applied {
  model: ModelName;
  id: number;
  /** The entity after the change, or undefined when it was removed. */
  entity: Entity | undefined;
  /**
   * Removed by a delete or a replacement (the server says it is gone from
   * its group) — not by a purge, a reset or a cleared model.
   */
  dropped: boolean;
}

export class Pool {
  readonly stores: {readonly [M in ModelName]: ModelStore<M>};
  private readonly byGroup = new Map<string, Set<Entity>>();
  /** Tombstones, oldest first: key (m, id, g) → v. */
  private readonly tombs = new Map<string, number>();
  /** The tombstone keys of each group (dropped when a floor or purge covers them). */
  private readonly tombsByGroup = new Map<string, Set<string>>();
  private readonly purged = new Map<string, number>();
  private readonly floors = new Map<string, Floor>();
  /** Buckets changed since the last `takeDirty` (the persister's work list). */
  private dirty: DirtyBuckets = new Map();
  /** Follower mode: the flush sequence each entity's state is from. */
  private readonly seqs: IdMap<number> = new Map();
  /** Follower mode: the flush that emptied a model's store (older states are gone). */
  private readonly clearedAt = new Map<ModelName, number>();
  private readonly listeners = new Set<(changes: readonly Applied[]) => void>();
  private pending: Applied[] = [];
  private depth = 0;
  /** The highest version any primitive has seen (for purges). */
  private maxSeen = 0;

  constructor() {
    const stores = {} as Record<ModelName, ModelStore>;
    for (const m of MODEL_NAMES) stores[m] = new ModelStore(m);
    this.stores = stores as Pool['stores'];
  }

  model<M extends ModelName>(m: M): ModelStore<M> {
    return this.stores[m];
  }

  /** Notes a version the server reached (welcome): purges from now on cover every state up to it. */
  noteVersion(v: number): void {
    this.seen(v);
  }

  /** The highest entity version the pool has applied or been told about. */
  get highestVersion(): number {
    return this.maxSeen;
  }

  /**
   * Runs fn as one MobX action: observers see its changes at once, and
   * `onApplied` listeners get them in one call afterwards.
   */
  batch<T>(fn: () => T): T {
    this.depth++;
    try {
      return runInAction(fn);
    } finally {
      this.depth--;
      if (this.depth === 0 && this.pending.length) {
        const changes = this.pending;
        this.pending = [];
        for (const l of this.listeners) l(changes);
      }
    }
  }

  /** Calls fn with the changes of every batch (after the batch). */
  onApplied(fn: (changes: readonly Applied[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The entities held in a group (not reactive; a live set). */
  groupEntities(group: string): ReadonlySet<Entity> {
    return this.byGroup.get(group) ?? EMPTY;
  }

  /** The groups that hold entities. */
  groups(): IterableIterator<string> {
    return this.byGroup.keys();
  }

  // ---- write primitives (leader) ----

  /** Applies an upsert: keeps it only if v is newer than what is held. Returns whether it changed anything. */
  /**
   * `authoritative`: a line of a bootstrap of `g` itself at watermark v —
   * the group's state as of v, which a tombstone, purge or floor *at* v
   * (an earlier response at the same log head) does not contradict.
   */
  put<M extends ModelName>(m: M, id: number, g: string, v: number, d: ModelTypes[M], authoritative = false): boolean {
    this.seen(v);
    const store = this.stores[m];
    const held = store._map.get(id);
    if (held && v <= held._v) return false;
    const stale = (marker: number | undefined) => marker !== undefined && (authoritative ? v < marker : v <= marker);
    if (stale(this.tombs.get(tombKey(m, id, g)))) return false;
    if (stale(this.purged.get(g))) return false;
    if (this.belowFloor(m, g, v, d, authoritative)) return false;
    this.upsert(store, held, id, g, v, d, true);
    return true;
  }

  /**
   * Records that a bootstrap of `group` at watermark `w` completed and
   * replaced the group (only `models` when given): from now on a state of the
   * group at or below `w` is stale unless `exempt` says the bootstrap's scope
   * left it out.
   */
  setFloor(group: string, w: number, models?: readonly string[], exempt?: (m: ModelName, d: unknown) => boolean): void {
    let f = this.floors.get(group);
    if (!f) this.floors.set(group, f = {all: 0, models: new Map(), exempt: undefined});
    if (models?.length) {
      for (const m of models) f.models.set(m, Math.max(f.models.get(m) ?? 0, w));
    } else {
      f.all = Math.max(f.all, w);
    }
    f.exempt = exempt;
    if (!exempt && !models?.length) this.dropTombs(group, f.all);
  }

  private belowFloor(m: ModelName, g: string, v: number, d: unknown, authoritative = false): boolean {
    const f = this.floors.size ? this.floors.get(g) : undefined;
    if (!f) return false;
    const floor = Math.max(f.all, f.models.get(m) ?? 0);
    if (authoritative ? v >= floor : v > floor) return false;
    return !f.exempt?.(m, d);
  }

  /** Applies a delete: the entity left group g at version v. Returns whether it removed anything. */
  del(m: ModelName, id: number, g: string, v: number): boolean {
    this.seen(v);
    this.tomb(m, id, g, v);
    const store = this.stores[m];
    const held = store._map.get(id);
    // A record of the entity in g may still be persisted (a crash between the chunks of a move): rewrite g's bucket.
    if (held?._g !== g) this.markBucket(m, g, bucketOf(g, id));
    if (!held || held._v >= v) return false;
    this.remove(store, held, true, true);
    return true;
  }

  /** The entity is not in group g as of maxV: drops it if held there at or below. */
  evict(m: ModelName, id: number, g: string, maxV: number): boolean {
    this.tomb(m, id, g, maxV);
    const store = this.stores[m];
    const held = store._map.get(id);
    if (held?._g !== g || held._v > maxV) return false;
    this.remove(store, held, true, true);
    return true;
  }

  /**
   * Drops everything held in a group (revocation, release) and keeps any
   * state of the group up to now from coming back (in-flight bootstrap lines
   * or frames). Returns the number of entities dropped.
   */
  purgeGroup(group: string): number {
    const maxV = this.maxSeen;
    const prev = this.purged.get(group);
    if (prev === undefined || prev < maxV) this.purged.set(group, maxV);
    this.dropTombs(group, maxV);
    const held = this.byGroup.get(group);
    if (!held) return 0;
    let n = 0;
    for (const e of [...held]) {
      if (e._v <= maxV) {
        this.remove(this.stores[e.model], e, true);
        n++;
      }
    }
    return n;
  }

  /**
   * Forgets a group completely — what is held, its tombstones, floors and
   * purge — so that a bootstrap from an older log position can fill it again
   * (bootstrap_required{cursor_unknown}: the held versions come from another
   * database, e.g. before a restore, and would win every version check).
   */
  resetGroup(group: string): number {
    const held = this.byGroup.get(group);
    let n = 0;
    for (const e of [...held ?? []]) {
      this.remove(this.stores[e.model], e, true);
      n++;
    }
    this.dropTombs(group, Number.POSITIVE_INFINITY);
    this.purged.delete(group);
    this.floors.delete(group);
    return n;
  }

  /**
   * Loads persisted records (IndexedDB hydration). They go through the same
   * version check as `put`, but are not marked dirty: they are what is
   * persisted. Returns the number loaded.
   */
  load<M extends ModelName>(m: M, records: readonly EntityRecord<M>[]): number {
    const store = this.stores[m];
    let n = 0;
    for (const r of records) {
      this.seen(r.v);
      const held = store._map.get(r.id);
      const t = this.tombs.size ? this.tombs.get(tombKey(m, r.id, r.g)) : undefined;
      const p = this.purged.size ? this.purged.get(r.g) : undefined;
      if ((held && r.v <= held._v) || (t !== undefined && r.v <= t) || (p !== undefined && r.v <= p) || this.belowFloor(m, r.g, r.v, r.d)) {
        // A stale persisted record (or a second copy left by a crash mid-flush): rewrite its bucket from memory.
        if (held?._g !== r.g || held._v !== r.v) this.markBucket(m, r.g, bucketOf(r.g, r.id));
        continue;
      }
      this.upsert(store, held, r.id, r.g, r.v, r.d, false);
      n++;
    }
    return n;
  }

  // ---- follower mode: the pool mirrors IndexedDB ----

  /**
   * Sets an entity to its persisted state as of flush `seq` (a record, or
   * null when it is not persisted). States from older flushes than the one
   * already applied are ignored, so reads and flush notifications can arrive
   * in any order.
   */
  mirror<M extends ModelName>(m: M, id: number, rec: EntityRecord<M> | null, seq: number): void {
    let seqs = this.seqs.get(m);
    if (!seqs) {
      seqs = new Map();
      this.seqs.set(m, seqs);
    }
    const last = seqs.get(id);
    if (last !== undefined && seq < last) return;
    const cleared = this.clearedAt.get(m);
    if (cleared !== undefined && seq < cleared) return;
    seqs.set(id, seq);
    const store = this.stores[m];
    const held = store._map.get(id);
    if (rec) {
      this.seen(rec.v);
      if (held?._v === rec.v && held._g === rec.g) return;
      // Two records of one flush (a stale copy left by a crash mid-flush): the newer state wins.
      if (last === seq && held && rec.v < held._v) return;
      this.upsert(store, held, id, rec.g, rec.v, rec.d, false);
    } else if (held) {
      this.remove(store, held, false);
    }
  }

  /**
   * After a complete read of every store as of flush `seq`: drops the
   * entities that read did not see unless a newer flush set them.
   */
  retainSeen(seen: ReadonlyMap<ModelName, ReadonlySet<number>>, seq: number): void {
    for (const m of MODEL_NAMES) {
      const store = this.stores[m];
      const ids = seen.get(m);
      const seqs = this.seqs.get(m);
      for (const e of [...store._map.values()]) {
        if (ids?.has(e.id)) continue;
        if ((seqs?.get(e.id) ?? -1) > seq) continue;
        this.remove(store, e, false);
      }
    }
  }

  // ---- persistence bookkeeping ----

  /** Takes the buckets changed since the last call. */
  takeDirty(): DirtyBuckets {
    const d = this.dirty;
    this.dirty = new Map();
    return d;
  }

  /** Marks buckets dirty again (a failed flush). */
  restoreDirty(d: DirtyBuckets): void {
    for (const [m, groups] of d) for (const [g, bs] of groups) for (const b of bs) this.markBucket(m, g, b);
  }

  /** The number of dirty buckets. */
  get dirtyCount(): number {
    let n = 0;
    for (const groups of this.dirty.values()) for (const bs of groups.values()) n += bs.size;
    return n;
  }

  /**
   * Follower mode: sets a persisted bucket to its content as of flush `seq`
   * (entities of the bucket not in `records` are gone, unless a newer flush
   * set them).
   */
  mirrorBucket<M extends ModelName>(m: M, g: string, b: number, records: readonly EntityRecord<M>[], seq: number): void {
    const store = this.stores[m];
    const keep = new Set(records.map((r) => r.id));
    for (const e of [...store._slot(g, b)]) if (!keep.has(e.id)) this.mirror(m, e.id, null, seq);
    for (const r of records) this.mirror(m, r.id, r, seq);
  }

  /**
   * Drops every entity of a model without marking anything dirty (its store
   * is emptied). A follower passes the flush that emptied it: states read
   * from older flushes are ignored from then on.
   */
  clearModel(m: ModelName, seq?: number): void {
    const store = this.stores[m];
    for (const e of [...store._map.values()]) this.remove(store, e, false);
    this.dirty.delete(m);
    this.seqs.delete(m);
    if (seq !== undefined) this.clearedAt.set(m, Math.max(this.clearedAt.get(m) ?? 0, seq));
  }

  // ---- internals ----

  private seen(v: number): void {
    if (v > this.maxSeen) this.maxSeen = v;
  }

  private tomb(m: ModelName, id: number, g: string, v: number): void {
    // A floor or purge of the group covering v says the same already.
    const f = this.floors.get(g);
    if (f && !f.exempt && v <= f.all) return;
    const p = this.purged.get(g);
    if (p !== undefined && v <= p) return;
    const k = tombKey(m, id, g);
    const t = this.tombs.get(k);
    if (t !== undefined) {
      if (t >= v) return;
      this.tombs.delete(k); // re-insert: keeps the map in age order
    }
    this.tombs.set(k, v);
    let keys = this.tombsByGroup.get(g);
    if (!keys) this.tombsByGroup.set(g, keys = new Set());
    keys.add(k);
    if (this.tombs.size > MAX_TOMBSTONES) {
      const oldest = this.tombs.keys().next();
      if (!oldest.done) this.dropTomb(oldest.value);
    }
  }

  private dropTomb(k: string): void {
    this.tombs.delete(k);
    const g = k.slice(k.lastIndexOf('\0') + 1);
    const keys = this.tombsByGroup.get(g);
    keys?.delete(k);
    if (keys?.size === 0) this.tombsByGroup.delete(g);
  }

  /** Drops the group's tombstones at or below v (a floor or purge covers them now). */
  private dropTombs(g: string, v: number): void {
    const keys = this.tombsByGroup.get(g);
    if (!keys) return;
    for (const k of [...keys]) if ((this.tombs.get(k) ?? 0) <= v) this.dropTomb(k);
  }

  private markBucket(m: ModelName, g: string, b: number): void {
    let groups = this.dirty.get(m);
    if (!groups) this.dirty.set(m, groups = new Map<string, Set<number>>());
    let bs = groups.get(g);
    if (!bs) groups.set(g, bs = new Set());
    bs.add(b);
  }

  private upsert<M extends ModelName>(store: ModelStore<M>, held: Entity<M> | undefined, id: number, g: string, v: number, d: ModelTypes[M], dirty: boolean): void {
    if (dirty) this.markBucket(store.model, g, bucketOf(g, id));
    if (held) {
      const old = held._d;
      const oldG = held._g;
      held._set(g, v, d);
      store._reindex(held, old);
      if (oldG !== g) {
        if (dirty) this.markBucket(store.model, oldG, bucketOf(oldG, id));
        this.groupRemove(oldG, held);
        store._slotRemove(oldG, held);
        this.groupAdd(g, held);
        store._slotAdd(g, held);
      }
      this.record(store.model, id, held);
      return;
    }
    const e = new Entity(store.model, id, g, v, d);
    store._insert(e);
    this.groupAdd(g, e);
    store._slotAdd(g, e);
    this.record(store.model, id, e);
  }

  private remove<M extends ModelName>(store: ModelStore<M>, e: Entity<M>, dirty: boolean, dropped = false): void {
    if (dirty) this.markBucket(store.model, e._g, bucketOf(e._g, e.id));
    store._delete(e);
    this.groupRemove(e._g, e);
    store._slotRemove(e._g, e);
    this.record(store.model, e.id, undefined, dropped);
  }

  private record(model: ModelName, id: number, entity: Entity | undefined, dropped = false): void {
    if (!this.listeners.size) return;
    if (this.depth > 0) {
      this.pending.push({model, id, entity, dropped});
      return;
    }
    const changes = [{model, id, entity, dropped}];
    for (const l of this.listeners) l(changes);
  }

  private groupAdd(g: string, e: Entity): void {
    let set = this.byGroup.get(g);
    if (!set) {
      set = new Set();
      this.byGroup.set(g, set);
    }
    set.add(e);
  }

  private groupRemove(g: string, e: Entity): void {
    const set = this.byGroup.get(g);
    if (!set) return;
    set.delete(e);
    if (set.size === 0) this.byGroup.delete(g);
  }
}

function tombKey(m: string, id: number, g: string): string {
  return `${m}\0${id}\0${g}`;
}
