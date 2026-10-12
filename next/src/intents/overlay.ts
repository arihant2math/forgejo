// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Pending intents layer over server state without mutating the pool; the latest field/member layer wins.
// Replay durable intents to rebuild layers after reload. Field/set atoms are lazy and scoped;
// revision is the coarse signal for cross-entity filters and sorting.

import {createAtom, type IAtom, runInAction} from 'mobx';
import {type Entity, observeLazy} from '../data/entity.ts';
import type {ModelName} from '../data/models.ts';

/** Owners are issue ids except CommentReaction (comment id); members are ids, reaction contents, or viewed paths. */
export type SetModel = 'IssueLabel' | 'IssueAssignee' | 'IssueDependency' | 'IssueSubscriber' | 'ReviewRequest' | 'IssueReaction' | 'CommentReaction' | 'ViewedFile';

export type Member = number | string;

export type OverlayOp =
  | {t: 'field'; model: ModelName; id: number; field: string; value: unknown}
  | {t: 'member'; model: SetModel; owner: number; member: Member; present: boolean}
  | {t: 'create'; entity: Entity};

/** The pseudo-field of an entity deleted locally (value true). */
export const DELETED = '~deleted';

interface Layer {
  id: string;
  ops: readonly OverlayOp[];
  seq: number;
}

const fieldKey = (model: string, id: number, field: string) => `${model}\0${String(id)}\0${field}`;
const setKey = (model: string, owner: number) => `${model}\0${String(owner)}`;
const createdKey = (model: string) => `+${model}`;

export class Overlay {
  private readonly layers = new Map<string, Layer>();
  /** field key → layers overriding it, oldest first. */
  private readonly fields = new Map<string, Layer[]>();
  /** set key → member → layers overriding it, oldest first. */
  private readonly sets = new Map<string, Map<Member, Layer[]>>();
  private readonly creates = new Map<ModelName, Map<number, Layer[]>>();
  private readonly atoms = new Map<string, IAtom>();
  private readonly issues = new Map<number, number>();
  private readonly rev = createAtom('overlay');
  private seq = 0;

  get size(): number {
    return this.layers.size;
  }

  /** Observing this reacts to every change of the overlay (for derivations over many entities). */
  get revision(): number {
    this.rev.reportObserved();
    return this.seq;
  }

  /** Untracked: whether any layer overrides something of this issue (else its server values stand). */
  touches(issueId: number): boolean {
    return this.issues.has(issueId);
  }

  has(layer: string): boolean {
    return this.layers.has(layer);
  }

  /** Adds a layer (replacing one with the same id). */
  add(id: string, ops: readonly OverlayOp[]): void {
    runInAction(() => {
      if (this.layers.has(id)) this.removeLayer(id);
      const layer: Layer = {id, ops, seq: ++this.seq};
      this.layers.set(id, layer);
      for (const op of ops) {
        this.count(op, 1);
        if (op.t === 'field') {
          const k = fieldKey(op.model, op.id, op.field);
          push(this.fields, k, layer);
          this.changed(k);
        } else if (op.t === 'member') {
          const k = setKey(op.model, op.owner);
          let members = this.sets.get(k);
          if (!members) this.sets.set(k, members = new Map<Member, Layer[]>());
          push(members, op.member, layer);
          this.changed(k);
        } else {
          const model = op.entity.model;
          let byId = this.creates.get(model);
          if (!byId) this.creates.set(model, byId = new Map<number, Layer[]>());
          push(byId, op.entity.id, layer);
          this.changed(createdKey(model));
        }
      }
      this.rev.reportChanged();
    });
  }

  remove(id: string): void {
    if (!this.layers.has(id)) return;
    runInAction(() => {
      this.removeLayer(id);
      this.seq++;
      this.rev.reportChanged();
    });
  }

  /** undefined uses server state; observes only overrides of this field. */
  field(model: ModelName, id: number, field: string): {value: unknown} | undefined {
    const k = fieldKey(model, id, field);
    observeLazy(this.atoms, k);
    const list = this.fields.get(k);
    const top = list?.at(-1);
    if (!top) return undefined;
    for (const op of top.ops) if (op.t === 'field' && op.model === model && op.id === id && op.field === field) return {value: op.value};
    return undefined;
  }

  /** member → present, observing only this set’s overrides. */
  members(model: SetModel, owner: number): ReadonlyMap<Member, boolean> | undefined {
    const k = setKey(model, owner);
    observeLazy(this.atoms, k);
    const members = this.sets.get(k);
    if (!members?.size) return undefined;
    const out = new Map<Member, boolean>();
    for (const [member, list] of members) {
      const top = list.at(-1);
      if (!top) continue;
      for (const op of top.ops) if (op.t === 'member' && op.model === model && op.owner === owner && op.member === member) out.set(member, op.present);
    }
    return out;
  }

  /** Untracked: the owners (issues) whose set has a pending override adding `member` (e.g. issues assigned to me). */
  ownersWith(model: SetModel, member: Member): number[] {
    const out: number[] = [];
    for (const [k, members] of this.sets) {
      if (!k.startsWith(`${model}\0`)) continue;
      const top = members.get(member)?.at(-1);
      if (!top) continue;
      for (const op of top.ops) if (op.t === 'member' && op.model === model && op.member === member && op.present) out.push(op.owner);
    }
    return out;
  }

  /** Top overrides in intent order; observes every overlay change. */
  fieldOverrides(model: ModelName, field: string): Map<number, unknown> {
    this.rev.reportObserved();
    const found: {id: number; value: unknown; seq: number}[] = [];
    const prefix = `${model}\0`;
    const suffix = `\0${field}`;
    for (const [k, list] of this.fields) {
      if (!k.startsWith(prefix) || !k.endsWith(suffix)) continue;
      const id = Number(k.slice(prefix.length, k.length - suffix.length));
      const top = list.at(-1);
      for (const op of top?.ops ?? []) if (top && op.t === 'field' && op.model === model && op.id === id && op.field === field) found.push({id, value: op.value, seq: top.seq});
    }
    return new Map(found.sort((a, b) => a.seq - b.seq).map((f) => [f.id, f.value]));
  }

  /** All layers in intent order, including repeated moves of one card; observes every overlay change. */
  fieldLayers(model: ModelName, field: string): [number, unknown][] {
    this.rev.reportObserved();
    const found: {id: number; value: unknown; seq: number}[] = [];
    const prefix = `${model}\0`;
    const suffix = `\0${field}`;
    for (const [k, list] of this.fields) {
      if (!k.startsWith(prefix) || !k.endsWith(suffix)) continue;
      const id = Number(k.slice(prefix.length, k.length - suffix.length));
      for (const layer of list) {
        for (const op of layer.ops) if (op.t === 'field' && op.model === model && op.id === id && op.field === field) found.push({id, value: op.value, seq: layer.seq});
      }
    }
    return found.sort((a, b) => a.seq - b.seq).map((f) => [f.id, f.value]);
  }

  /** Untracked set state before layer, including that layer only when inclusive. */
  membersUpTo(model: SetModel, owner: number, layer: string, inclusive: boolean): ReadonlyMap<Member, boolean> {
    const until = this.layers.get(layer)?.seq ?? Number.POSITIVE_INFINITY;
    const out = new Map<Member, boolean>();
    const members = this.sets.get(setKey(model, owner));
    for (const [member, list] of members ?? []) {
      let top: Layer | undefined;
      for (const l of list) if (l.seq < until || (inclusive && l.seq === until)) top = l;
      if (!top) continue;
      for (const op of top.ops) if (op.t === 'member' && op.model === model && op.owner === owner && op.member === member) out.set(member, op.present);
    }
    return out;
  }

  /** Local entities, oldest first; observes this model’s creations and removals. */
  created(model: ModelName): Entity[] {
    observeLazy(this.atoms, createdKey(model));
    const out: Entity[] = [];
    for (const list of this.creates.get(model)?.values() ?? []) {
      const top = list.at(-1);
      if (!top) continue;
      for (const op of top.ops) if (op.t === 'create' && op.entity.model === model) out.push(op.entity);
    }
    return out;
  }

  createdEntity(model: ModelName, id: number): Entity | undefined {
    observeLazy(this.atoms, createdKey(model));
    const top = this.creates.get(model)?.get(id)?.at(-1);
    for (const op of top?.ops ?? []) if (op.t === 'create' && op.entity.model === model && op.entity.id === id) return op.entity;
    return undefined;
  }

  private removeLayer(id: string): void {
    const layer = this.layers.get(id);
    if (!layer) return;
    this.layers.delete(id);
    for (const op of layer.ops) {
      this.count(op, -1);
      if (op.t === 'field') {
        const k = fieldKey(op.model, op.id, op.field);
        pull(this.fields, k, layer);
        this.changed(k);
      } else if (op.t === 'create') {
        const byId = this.creates.get(op.entity.model);
        if (byId) {
          pull(byId, op.entity.id, layer);
          if (!byId.size) this.creates.delete(op.entity.model);
        }
        this.changed(createdKey(op.entity.model));
      } else {
        const k = setKey(op.model, op.owner);
        const members = this.sets.get(k);
        if (members) {
          pull(members, op.member, layer);
          if (!members.size) this.sets.delete(k);
        }
        this.changed(k);
      }
    }
  }

  private count(op: OverlayOp, by: 1 | -1): void {
    const issue = op.t === 'field' ? (op.model === 'Issue' ? op.id : undefined) :
      op.t === 'create' ? (op.entity.model === 'Issue' ? op.entity.id : undefined) :
      op.model === 'CommentReaction' ? undefined : op.owner;
    if (issue === undefined) return;
    const n = (this.issues.get(issue) ?? 0) + by;
    if (n > 0) this.issues.set(issue, n);
    else this.issues.delete(issue);
  }

  private changed(k: string): void {
    this.atoms.get(k)?.reportChanged();
  }
}

function push<K>(map: Map<K, Layer[]>, k: K, layer: Layer): void {
  const list = map.get(k);
  if (list) {
    if (!list.includes(layer)) list.push(layer);
  } else {
    map.set(k, [layer]);
  }
}

function pull<K>(map: Map<K, Layer[]>, k: K, layer: Layer): void {
  const list = map.get(k);
  if (!list) return;
  const i = list.indexOf(layer);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) map.delete(k);
}
