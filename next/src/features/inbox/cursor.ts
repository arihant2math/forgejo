// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Shift-click ranges start at the selection anchor, not the remembered cursor.
// Without a selection, Shift-click selects only the clicked row.

import {untracked} from 'mobx';
import {ListCursor} from '../issues/flags.ts';

export class InboxCursor extends ListCursor {
  private anchor: number | undefined;

  override selectRange(id: number, order: readonly number[]): void {
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
}
