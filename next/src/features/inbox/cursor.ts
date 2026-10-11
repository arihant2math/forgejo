// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The inbox's cursor and selection. A Shift-click range starts from the
// selection's anchor (the row last added to it), not from the cursor: the
// cursor stays on a row after Esc, after opening it and coming back, or on
// the remembered row, and a range from there selected rows the user never
// saw selected — then E marked them all read (#228). Without a selection
// there is no anchor: Shift-click selects the clicked row alone.

import {untracked} from 'mobx';
import {ListCursor} from '../issues/flags.ts';

export class InboxCursor extends ListCursor {
  /** Where a Shift-click range starts: the row last added to the selection (only while it is selected). */
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

  /** Adds the row to the selection or takes it out (X, a tap in select mode); an added row is the new anchor. */
  toggle(id: number): void {
    this.selected.toggle(id);
    if (untracked(() => this.selected.has(id))) this.anchor = id;
    else if (this.anchor === id) this.anchor = undefined;
  }

  /** Clears the selection, and with it the anchor (Esc, "Clear"). */
  clearSelection(): void {
    this.selected.clear();
    this.anchor = undefined;
  }
}
