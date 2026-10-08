// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The optimistic overlay (PLAN §5.4): local overrides on top of the pool's
// server state. The pool is never written by the UI; what the user changed
// and the server has not confirmed yet lives here, as one *layer* per
// intent, and readers combine the two (src/features/issues/view.ts).
//
//   overlay.add(intent.id, ops)   applied synchronously (same frame)
//   overlay.remove(intent.id)     confirmed (the pool holds the write now) or rolled back
//
// Three kinds of override:
//   field  (model, id, field) = value            a scalar: Issue.state, Issue.milestone_id,
//                                                IssueBody.body, Comment.body, Notification.status;
//                                                pseudo-fields start with "~" (DELETED, board cards)
//   member (model, owner, member) = present?     a set: an issue's labels (IssueLabel by
//                                                issue_id), its assignees (IssueAssignee), the
//                                                viewer's reactions (by content), viewed files (by path)
//   create (model, entity)                       an entity created locally (a comment, an issue)
//                                                under a temporary id (intents.ts tempId), until
//                                                the server's one arrives in the pool
// The latest layer wins per field / member. Layers are kept in the order
// they were added; removing a layer reveals the one below it, or the server.
//
// Reactivity follows the pool's rule ("one delta, one cell"): every field
// and every set has its own lazily created atom, so a row's label cell
// reacts to that issue's label overrides only. `revision` is one coarse atom
// for derivations over many entities (a list's filter and sort), which read
// the overrides untracked afterwards.
//
// F5 makes intents durable (IndexedDB) and replays them after a reload: it
// re-adds their layers here from the stored intents (`ops` is a pure function
// of the intent, see intents.ts), so this module keeps no state of its own
// that would need persisting.

import {createAtom, type IAtom, runInAction} from 'mobx';
import {type Entity, observeLazy} from '../data/entity.ts';
import type {ModelName} from '../data/models.ts';

/**
 * Sets an intent can change: an issue's labels, assignees, dependencies
 * (dependency issue ids), subscribers and requested reviewers (user ids); the
 * viewer's reactions on an issue (owner: issue id) or a comment (owner:
 * comment id), by content; a pull request's viewed files (owner: issue id), by path.
 */
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
  /** model → entity id → layers creating it (one, normally). */
  private readonly creates = new Map<ModelName, Map<number, Layer[]>>();
  private readonly atoms = new Map<string, IAtom>();
  /** Issue id → ops of pending layers on it (an issue's fields or sets): untracked `touches`. */
  private readonly issues = new Map<number, number>();
  private readonly rev = createAtom('overlay');
  private seq = 0;

  /** The number of layers (intents not confirmed or rolled back yet). */
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

  /** Removes a layer; what it overrode shows the layer below or the server value again. */
  remove(id: string): void {
    if (!this.layers.has(id)) return;
    runInAction(() => {
      this.removeLayer(id);
      this.seq++;
      this.rev.reportChanged();
    });
  }

  /**
   * The override of a field, as `{value}`, or undefined (show the server's).
   * Observing it reacts to overrides of this field only.
   */
  field(model: ModelName, id: number, field: string): {value: unknown} | undefined {
    const k = fieldKey(model, id, field);
    observeLazy(this.atoms, k);
    const list = this.fields.get(k);
    const top = list?.at(-1);
    if (!top) return undefined;
    for (const op of top.ops) if (op.t === 'field' && op.model === model && op.id === id && op.field === field) return {value: op.value};
    return undefined;
  }

  /**
   * The overridden members of a set (e.g. the labels of issue `owner`):
   * member → present. Observing it reacts to overrides of this set only.
   */
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

  /**
   * The overrides of a set made by the layers added before `layer` (and by
   * `layer` itself when `inclusive`): what the set looked like to the user
   * when that intent was made. Untracked.
   */
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

  /**
   * The entities of a model created locally (temporary ids), oldest first.
   * Observing it reacts to creations and removals of that model only.
   */
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

  /** A locally created entity by its temporary id. */
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
