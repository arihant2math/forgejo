// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {InboxCursor} from './cursor.ts';

const ORDER = [1, 2, 3, 4, 5, 6];

test('Shift-click ranges start from the selection, never from a cursor left on a row (#228)', () => {
  const c = new InboxCursor();
  // The cursor on row 2 (J, a row come back to): no selection, so no anchor.
  c.setActive(2);
  c.selectRange(5, ORDER);
  expect(c.selected.values()).toEqual([5]);
  c.selectRange(3, ORDER);
  expect(c.selected.values().sort()).toEqual([3, 4, 5]);
  // Esc: the anchor goes with the selection.
  c.clearSelection();
  c.selectRange(6, ORDER);
  expect(c.selected.values()).toEqual([6]);
  // X adds a row and makes it the anchor; taking it out again leaves no anchor.
  c.clearSelection();
  c.toggle(1);
  c.selectRange(3, ORDER);
  expect(c.selected.values().sort()).toEqual([1, 2, 3]);
  c.clearSelection();
  c.toggle(4);
  c.toggle(4);
  c.selectRange(6, ORDER);
  expect(c.selected.values()).toEqual([6]);
  // A row filtered out of the list (the anchor) ends the range there too.
  c.keep(new Set([1, 2, 3, 4, 5]));
  c.selectRange(2, ORDER);
  expect(c.selected.values()).toEqual([2]);
});

test('rows that leave the list leave the selection and the anchor, and the cursor when none is left (#262)', () => {
  const c = new InboxCursor();
  c.setActive(4);
  for (const id of [1, 2, 3, 4]) c.toggle(id);
  c.keepSelected(new Set([1, 2]));
  expect(c.selected.values().sort()).toEqual([1, 2]);
  // The list hands the cursor on itself (it knows the old order).
  expect(c.activeId).toBe(4);
  // Every row gone (the empty state): nothing stays selected, and no row has the cursor.
  c.keepSelected(new Set());
  expect(c.selected.values()).toEqual([]);
  expect(c.activeId).toBeUndefined();
  expect(c.active.values()).toEqual([]);
  // The rows back (Undo): not selected, and no anchor for a Shift-click range.
  c.keepSelected(new Set(ORDER));
  expect(c.selected.values()).toEqual([]);
  c.selectRange(6, ORDER);
  expect(c.selected.values()).toEqual([6]);
});
