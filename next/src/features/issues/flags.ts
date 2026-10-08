// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createAtom, type IAtom, runInAction} from 'mobx';
import {observeLazy} from '../../data/entity.ts';

/**
 * A set of ids where observing `has(id)` reacts to that id only: moving the
 * keyboard cursor or selecting a row re-renders the two rows concerned, not
 * every row on screen. `size`/`values` observe the whole set.
 */
export class KeyedFlags {
  private readonly set = new Set<number>();
  private readonly atoms = new Map<number, IAtom>();
  private readonly all = createAtom('flags');

  has(id: number): boolean {
    observeLazy(this.atoms, id);
    return this.set.has(id);
  }

  get size(): number {
    this.all.reportObserved();
    return this.set.size;
  }

  values(): number[] {
    this.all.reportObserved();
    return [...this.set];
  }

  /** Makes the set exactly `ids`. */
  replace(ids: Iterable<number>): void {
    const next = new Set(ids);
    runInAction(() => {
      let changed = false;
      for (const id of this.set) {
        if (next.has(id)) continue;
        this.set.delete(id);
        this.atoms.get(id)?.reportChanged();
        changed = true;
      }
      for (const id of next) {
        if (this.set.has(id)) continue;
        this.set.add(id);
        this.atoms.get(id)?.reportChanged();
        changed = true;
      }
      if (changed) this.all.reportChanged();
    });
  }

  toggle(id: number): void {
    runInAction(() => {
      if (!this.set.delete(id)) this.set.add(id);
      this.atoms.get(id)?.reportChanged();
      this.all.reportChanged();
    });
  }

  clear(): void {
    this.replace([]);
  }
}
