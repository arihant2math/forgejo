// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Monotonic versions make overlapping deltas, bootstraps, and hydration converge.
// Group-scoped tombstones block stale resurrection without rejecting moves to other groups.
// Bootstrap floors cover missing entities except out-of-scope states; purges cover the whole group.
// Tombstones and floors are memory-only: pre-reload messages cannot arrive after reload.

import {_isComputingDerivation, createAtom, type IAtom, runInAction} from 'mobx';
import {Entity, type EntityRecord, observeLazy} from './entity.ts';
import {type GroupKind, groupKind, MODEL_NAMES, MODELS, type ModelDefs, type ModelName, type ModelTypes} from './models.ts';

export type IndexedField<M extends ModelName> =
  ModelDefs[M] extends {index: readonly (infer F)[]} ? F & keyof ModelTypes[M] & string : never;

interface Bucket<M extends ModelName> {
  set: Set<Entity<M>>;
  atoms: Map<0, IAtom> | undefined;
}

const EMPTY: ReadonlySet<never> = new Set();

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

  /** A live set: do not retain it across reactions. Observes membership, not entity fields. */
  by<K extends IndexedField<M>>(field: K, value: ModelTypes[M][K]): ReadonlySet<Entity<M>> {
    const index = this.indexes.get(field);
    if (!index) throw new Error(`${this.model}.${field} is not indexed`);
    let bucket = index.get(value);
    if (!bucket) {
      if (!_isComputingDerivation()) return EMPTY;
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

type IdMap<T> = Map<ModelName, Map<number, T>>;

/** Per model, per group: the persistence buckets whose content changed. */
export type DirtyBuckets = Map<ModelName, Map<string, Set<number>>>;

/** Bucketing reduces per-record IndexedDB overhead while limiting rewrite size.
 * Changing counts requires bumping IDB_VERSION and rebuilding model stores.
 */
const KIND_BUCKETS: Record<GroupKind, number> = {repo: 32, profiles: 32, user: 8, org: 8, owner: 4, profile: 2, issue: 2, team: 2};

/** Upper bound of every bucket number (key ranges over a whole group). */
export const MAX_BUCKETS = 1024;

const bucketCounts = new Map<string, number>();

export function bucketOf(g: string, id: number): number {
  let n = bucketCounts.get(g);
  if (n === undefined) {
    const kind = groupKind(g);
    n = kind ? KIND_BUCKETS[kind] : 1;
    if (bucketCounts.size > 100_000) bucketCounts.clear();
    bucketCounts.set(g, n);
  }
  return ((id % n) + n) % n;
}

/** The maximum number of tombstones kept; the oldest go first. */
export const MAX_TOMBSTONES = 50_000;

export interface Applied {
  model: ModelName;
  id: number;
  /** The entity after the change, or undefined when it was removed. */
  entity: Entity | undefined;
  /** Server removal, not a local purge, reset, or model clear. */
  dropped: boolean;
}

export class Pool {
  readonly stores: {readonly [M in ModelName]: ModelStore<M>};
  private readonly byGroup = new Map<string, Set<Entity>>();
  /** Tombstones, oldest first: key (m, id, g) → v. */
  private tombs = new Map<string, number>();
  /** The previous generation of tombstones (two generations of MAX_TOMBSTONES / 2 each: evicting is O(1)). */
  private tombsOld = new Map<string, number>();
  private readonly tombsByGroup = new Map<string, Set<string>>();
  private readonly purged = new Map<string, number>();
  private readonly floors = new Map<string, Floor>();
  private dirty: DirtyBuckets = new Map();
  /** Follower mode: the flush sequence each entity's state is from. */
  private readonly seqs: IdMap<number> = new Map();
  /** Follower mode: the flush that emptied a model's store (older states are gone). */
  private readonly clearedAt = new Map<ModelName, number>();
  private readonly droppedAt = new Map<string, number>();
  /** Blocks in-flight hydration from resurrecting purged groups or cleared models. */
  private readonly unloadable = {groups: new Set<string>(), models: new Set<ModelName>()};
  private readonly listeners = new Set<(changes: readonly Applied[]) => void>();
  private pending: Applied[] = [];
  private depth = 0;
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

  get highestVersion(): number {
    return this.maxSeen;
  }

  /** One MobX action; onApplied listeners receive the batch afterwards. */
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

  groups(): IterableIterator<string> {
    return this.byGroup.keys();
  }

  /** Keeps newer versions; returns whether state changed.
     * Authoritative own-group bootstrap lines may equal a tombstone, purge, or floor watermark.
     */
  put<M extends ModelName>(m: M, id: number, g: string, v: number, d: ModelTypes[M], authoritative = false): boolean {
    this.seen(v);
    const store = this.stores[m];
    const held = store._map.get(id);
    if (held && v <= held._v) return false;
    const stale = (marker: number | undefined) => marker !== undefined && (authoritative ? v < marker : v <= marker);
    if (stale(this.getTomb(tombKey(m, id, g)))) return false;
    if (stale(this.purged.get(g))) return false;
    if (this.belowFloor(m, g, v, d, authoritative)) return false;
    this.upsert(store, held, id, g, v, d, true);
    return true;
  }

  /** Marks states at or below w stale for the given models (all if omitted), except out-of-scope states. */
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

  /** Drops the group and blocks in-flight states up to the highest seen version; returns the count. */
  purgeGroup(group: string): number {
    const maxV = this.maxSeen;
    this.unloadable.groups.add(group);
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

  /** Clears state and all version guards so cursor_unknown can bootstrap from a restored database. */
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
    this.unloadable.groups.add(group);
    return n;
  }

  /** Loads persisted records through version guards without marking accepted records dirty; returns the count. */
  load<M extends ModelName>(m: M, records: readonly EntityRecord<M>[]): number {
    const store = this.stores[m];
    if (this.unloadable.models.has(m)) return 0;
    const skipGroups = this.unloadable.groups.size ? this.unloadable.groups : undefined;
    let n = 0;
    for (const r of records) {
      if (skipGroups?.has(r.g)) continue;
      this.seen(r.v);
      const held = store._map.get(r.id);
      const t = this.tombs.size || this.tombsOld.size ? this.getTomb(tombKey(m, r.id, r.g)) : undefined;
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

  /** Mirrors persisted state (null means absent), ignoring older flushes regardless of arrival order. */
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
    if (rec) {
      const dropped = this.droppedAt.get(rec.g);
      if (dropped !== undefined && seq < dropped) return;
    }
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

  /** Drops unseen entities after a complete read, unless a newer flush set them. */
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

  /** Takes the buckets changed since the last call. */
  takeDirty(): DirtyBuckets {
    const d = this.dirty;
    this.dirty = new Map();
    return d;
  }

  restoreDirty(d: DirtyBuckets): void {
    for (const [m, groups] of d) for (const [g, bs] of groups) for (const b of bs) this.markBucket(m, g, b);
  }

  get dirtyCount(): number {
    let n = 0;
    for (const groups of this.dirty.values()) for (const bs of groups.values()) n += bs.size;
    return n;
  }

  /** Replaces a persisted bucket as of seq, preserving entities set by newer flushes. */
  mirrorBucket<M extends ModelName>(m: M, g: string, b: number, records: readonly EntityRecord<M>[], seq: number): void {
    const store = this.stores[m];
    const keep = new Set(records.map((r) => r.id));
    for (const e of [...store._slot(g, b)]) if (!keep.has(e.id)) this.mirror(m, e.id, null, seq);
    for (const r of records) this.mirror(m, r.id, r, seq);
  }

  /** Clears without dirtying; followers reject reads older than seq, leaders block further hydration. */
  clearModel(m: ModelName, seq?: number): void {
    const store = this.stores[m];
    for (const e of [...store._map.values()]) this.remove(store, e, false);
    this.dirty.delete(m);
    this.seqs.delete(m);
    if (seq !== undefined) this.clearedAt.set(m, Math.max(this.clearedAt.get(m) ?? 0, seq));
    else this.unloadable.models.add(m);
  }

  /** Follower mode: the group's buckets were deleted by flush `seq`. */
  mirrorDropGroup(g: string, seq: number): void {
    this.droppedAt.set(g, Math.max(this.droppedAt.get(g) ?? 0, seq));
    for (const e of [...this.byGroup.get(g) ?? []]) this.mirror(e.model, e.id, null, seq);
  }

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
    const t = this.getTomb(k);
    if (t !== undefined && t >= v) return;
    this.tombs.set(k, v);
    this.tombsOld.delete(k);
    let keys = this.tombsByGroup.get(g);
    if (!keys) this.tombsByGroup.set(g, keys = new Set());
    keys.add(k);
    if (this.tombs.size >= MAX_TOMBSTONES / 2) {
      for (const old of this.tombsOld.keys()) this.unindexTomb(old);
      this.tombsOld = this.tombs;
      this.tombs = new Map();
    }
  }

  private getTomb(k: string): number | undefined {
    return this.tombs.get(k) ?? this.tombsOld.get(k);
  }

  private dropTomb(k: string): void {
    this.tombs.delete(k);
    this.tombsOld.delete(k);
    this.unindexTomb(k);
  }

  private unindexTomb(k: string): void {
    const g = k.slice(k.lastIndexOf('\0') + 1);
    const keys = this.tombsByGroup.get(g);
    keys?.delete(k);
    if (keys?.size === 0) this.tombsByGroup.delete(g);
  }

  private dropTombs(g: string, v: number): void {
    const keys = this.tombsByGroup.get(g);
    if (!keys) return;
    for (const k of [...keys]) if ((this.getTomb(k) ?? 0) <= v) this.dropTomb(k);
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
