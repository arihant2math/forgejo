// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {InboxCursor} from './cursor.ts';

const ORDER = [1, 2, 3, 4, 5, 6];

test('Shift-click ranges start from the selection, never from a cursor left on a row (#228)', () => {
  const c = new InboxCursor();
  c.setActive(2);
  c.selectRange(5, ORDER);
  expect(c.selected.values()).toEqual([5]);
  c.selectRange(3, ORDER);
  expect(c.selected.values().sort()).toEqual([3, 4, 5]);
  c.clearSelection();
  c.selectRange(6, ORDER);
  expect(c.selected.values()).toEqual([6]);
  c.clearSelection();
  c.toggle(1);
  c.selectRange(3, ORDER);
  expect(c.selected.values().sort()).toEqual([1, 2, 3]);
  c.clearSelection();
  c.toggle(4);
  c.toggle(4);
  c.selectRange(6, ORDER);
  expect(c.selected.values()).toEqual([6]);
  c.keep(new Set([1, 2, 3, 4, 5]));
  c.selectRange(2, ORDER);
  expect(c.selected.values()).toEqual([2]);
});
