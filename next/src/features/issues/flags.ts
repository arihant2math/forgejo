// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observable, runInAction, untracked} from 'mobx';

/** has(id) observes only that id; size and values observe the whole set. */
export class KeyedFlags {
  private readonly map = observable.map<number, true>(undefined, {deep: false});

  has(id: number): boolean {
    return this.map.has(id);
  }

  get size(): number {
    return this.map.size;
  }

  values(): number[] {
    return [...this.map.keys()];
  }

  replace(ids: Iterable<number>): void {
    runInAction(() => {
      this.map.replace([...ids].map((id) => [id, true]));
    });
  }

  toggle(id: number): void {
    runInAction(() => {
      if (!this.map.delete(id)) this.map.set(id, true);
    });
  }

  clear(): void {
    runInAction(() => {
      this.map.clear();
    });
  }
}

/**
 * Shift-click ranges start at the selection's anchor, never at the cursor: the cursor may sit on a remembered or
 * returned-to row the user never selected. Without a selection, Shift-click selects only the clicked row.
 */
export class ListCursor {
  readonly active = new KeyedFlags();
  readonly selected = new KeyedFlags();
  /** The cursor's issue (not observable; `active` is). */
  activeId: number | undefined;
  private anchor: number | undefined;

  setActive(id: number | undefined): void {
    this.activeId = id;
    this.active.replace(id === undefined ? [] : [id]);
  }

  /** Adds the anchor-to-id range in list order, then makes id the anchor and the cursor. */
  selectRange(id: number, order: readonly number[]): void {
    const sel = untracked(() => this.selected.values());
    const from = this.anchor !== undefined && sel.includes(this.anchor) ? order.indexOf(this.anchor) : -1;
    const to = order.indexOf(id);
    const range = from < 0 || to < 0 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
    this.selected.replace([...sel, ...range]);
    this.anchor = id;
    this.setActive(id);
  }

  /** Added rows become the range anchor. */
  toggle(id: number): void {
    this.selected.toggle(id);
    if (untracked(() => this.selected.has(id))) this.anchor = id;
    else if (this.anchor === id) this.anchor = undefined;
  }

  clearSelection(): void {
    this.selected.clear();
    this.anchor = undefined;
  }

  /** Actions target the selection, falling back to the cursor. */
  targets(): number[] {
    const sel = untracked(() => this.selected.values());
    if (sel.length) return sel;
    return this.activeId === undefined ? [] : [this.activeId];
  }

  keep(listed: ReadonlySet<number>): void {
    if (this.activeId !== undefined && !listed.has(this.activeId)) this.setActive(undefined);
    const sel = untracked(() => this.selected.values());
    if (sel.some((id) => !listed.has(id))) this.selected.replace(sel.filter((id) => listed.has(id)));
  }
}
