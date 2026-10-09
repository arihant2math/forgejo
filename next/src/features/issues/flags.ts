// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createAtom, type IAtom, runInAction, untracked} from 'mobx';
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

/** The cursor (J/K) and the selection (X) of a list. */
export class ListCursor {
  readonly active = new KeyedFlags();
  readonly selected = new KeyedFlags();
  /** The cursor's issue (not observable; `active` is). */
  activeId: number | undefined;

  setActive(id: number | undefined): void {
    this.activeId = id;
    this.active.replace(id === undefined ? [] : [id]);
  }

  /**
   * Shift+click (Linear, Gmail): selects every row from the cursor's (the anchor) to `id` in list order, adding to
   * the selection; without a cursor it selects `id`. The cursor moves to `id`.
   */
  selectRange(id: number, order: readonly number[]): void {
    const from = this.activeId === undefined ? -1 : order.indexOf(this.activeId);
    const to = order.indexOf(id);
    const range = from < 0 || to < 0 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
    this.selected.replace([...untracked(() => this.selected.values()), ...range]);
    this.setActive(id);
  }

  /** What actions apply to: the selection, else the cursor's issue. */
  targets(): number[] {
    const sel = untracked(() => this.selected.values());
    if (sel.length) return sel;
    return this.activeId === undefined ? [] : [this.activeId];
  }

  /** Keeps only issues that are listed (a closed or filtered-out issue leaves the cursor and the selection). */
  keep(listed: ReadonlySet<number>): void {
    if (this.activeId !== undefined && !listed.has(this.activeId)) this.setActive(undefined);
    const sel = untracked(() => this.selected.values());
    if (sel.some((id) => !listed.has(id))) this.selected.replace(sel.filter((id) => listed.has(id)));
  }
}
