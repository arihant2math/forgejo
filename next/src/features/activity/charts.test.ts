// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {barsPath} from './charts.tsx';

test('bars are one path: a rectangle per non-zero column, up or down from the baseline', () => {
  // Columns 10 units wide with a gap of 2: x = i*10 + 1, width 8.
  expect(barsPath([0, 5, 10], 10, 100, -1, 100)).toBe('M11 100v-50h8v50zM21 100v-100h8v100z');
  expect(barsPath([2], 4, 50, 1, 50)).toBe('M1 50v25h8v-25z');
  // A tiny value stays visible; values above the scale are capped; nothing to draw without a scale.
  expect(barsPath([1, 20], 1000, 100, -1, 100)).toBe('M1 100v-0.5h8v0.5zM11 100v-2h8v2z');
  expect(barsPath([5], 1, 100, -1, 100)).toBe('M1 100v-100h8v100z');
  expect(barsPath([5], 0, 100, -1, 100)).toBe('');
});
