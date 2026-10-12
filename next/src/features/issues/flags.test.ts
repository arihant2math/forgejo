// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {autorun} from 'mobx';
import {expect, test} from 'vitest';
import {KeyedFlags, ListCursor} from './flags.ts';

const ORDER = [1, 2, 3, 4, 5, 6];

test('Shift-click ranges start from the selection, never from a cursor left on a row', () => {
  const c = new ListCursor();
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

test('size and values react to membership changes, not to a replace with the same ids', () => {
  const f = new KeyedFlags();
  let runs = 0;
  const off = autorun(() => {
    f.values();
    runs++;
  });
  f.replace([1, 2]);
  f.replace([2, 1, 1]);
  expect(f.values().sort()).toEqual([1, 2]);
  expect(f.size).toBe(2);
  const before = runs;
  f.replace([2, 1]);
  expect(runs).toBe(before);
  off();
});
