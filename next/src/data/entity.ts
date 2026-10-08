// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// An entity of the object pool: one server entity (model, id) with its
// current state. Every field is observable on its own ("one delta, one
// cell", PLAN §1), but the observables are MobX atoms created lazily, only
// for the fields a reaction actually reads, and dropped again when nothing
// observes them. A bulk load of 50 000 issues therefore creates no
// observables at all; a list row that shows an issue's title and state
// creates two.

import {_isComputingDerivation, createAtom, type IAtom} from 'mobx';
import type {ModelName, ModelTypes} from './models.ts';

/** The persisted form of an entity (one IndexedDB record per entity). */
export interface EntityRecord<M extends ModelName = ModelName> {
  id: number;
  /** The entity's group (protocol.Change.g). */
  g: string;
  /** The entity's version: the sync id of the state (protocol.Change.v). */
  v: number;
  d: ModelTypes[M];
}

/** Atom names that are not DTO fields. */
const WHOLE = '\0data';
const GROUP = '\0group';
const VERSION = '\0version';

/**
 * Reports an observation of the lazily created atom `name` in `atoms`. Outside
 * a reactive context nothing is created (there is nobody to notify).
 */
export function observeLazy<K>(atoms: Map<K, IAtom>, name: K, onUnobserved?: () => void): void {
  const atom = atoms.get(name);
  if (atom) {
    atom.reportObserved();
    return;
  }
  if (!_isComputingDerivation()) return;
  const created = createAtom('pool', undefined, () => {
    if (atoms.get(name) === created) atoms.delete(name);
    onUnobserved?.();
  });
  atoms.set(name, created);
  created.reportObserved();
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  // Arrays and maps of a DTO (topics, needs, config, …) are small.
  return JSON.stringify(a) === JSON.stringify(b);
}

export class Entity<M extends ModelName = ModelName> {
  readonly model: M;
  readonly id: number;
  /** @internal Use `version`. */
  _v: number;
  /** @internal Use `group`. */
  _g: string;
  /** @internal Use `get` / `data`. */
  _d: ModelTypes[M];
  /** @internal The atoms of observed fields (lazily created). */
  _atoms: Map<string, IAtom> | undefined;

  constructor(model: M, id: number, g: string, v: number, d: ModelTypes[M]) {
    this.model = model;
    this.id = id;
    this._g = g;
    this._v = v;
    this._d = d;
  }

  /** One field of the entity's state; observing it reacts to changes of that field only. */
  get<K extends keyof ModelTypes[M] & string>(field: K): ModelTypes[M][K] {
    this.observe(field);
    return this._d[field];
  }

  /** The whole state (treat it as immutable); observing it reacts to every change. */
  get data(): Readonly<ModelTypes[M]> {
    this.observe(WHOLE);
    return this._d;
  }

  /** The sync group the entity is in. */
  get group(): string {
    this.observe(GROUP);
    return this._g;
  }

  /** The entity's version (the sync id of its state). */
  get version(): number {
    this.observe(VERSION);
    return this._v;
  }

  /** The record persisted for this entity. */
  record(): EntityRecord<M> {
    return {id: this.id, g: this._g, v: this._v, d: this._d};
  }

  private observe(name: string): void {
    this._atoms ??= new Map();
    observeLazy(this._atoms, name);
  }

  /**
   * @internal Replaces the state and notifies the observers of what changed:
   * only the observed fields are compared, so an update costs nothing for
   * fields nobody shows.
   */
  _set(g: string, v: number, d: ModelTypes[M]): void {
    const old = this._d;
    const oldG = this._g;
    const oldV = this._v;
    this._g = g;
    this._v = v;
    this._d = d;
    const atoms = this._atoms;
    if (!atoms?.size) return;
    for (const [name, atom] of atoms) {
      switch (name) {
        case WHOLE:
          if (old !== d) atom.reportChanged();
          break;
        case GROUP:
          if (oldG !== g) atom.reportChanged();
          break;
        case VERSION:
          if (oldV !== v) atom.reportChanged();
          break;
        default:
          if (!same(old[name as keyof ModelTypes[M]], d[name as keyof ModelTypes[M]])) atom.reportChanged();
      }
    }
  }
}
