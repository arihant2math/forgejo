// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {dueOptions, parseDue} from './Picker.tsx';

// A Wednesday.
const NOW = new Date(2026, 9, 7, 15, 30).getTime();

test('due date presets: today, tomorrow, Friday, next Monday, two weeks, a month', () => {
  expect(dueOptions(NOW).map((o) => o.day)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-21', '2026-11-07']);
});

test('typed due dates', () => {
  expect(parseDue('2026-12-24', NOW)).toBe('2026-12-24');
  expect(parseDue('3 days', NOW)).toBe('2026-10-10');
  expect(parseDue('in 2 weeks', NOW)).toBe('2026-10-21');
  expect(parseDue('oct 20', NOW)).toBe('2026-10-20');
  expect(parseDue('tomorrow', NOW)).toBeUndefined(); // a preset, found by its name
  expect(parseDue('12', NOW)).toBeUndefined();
  expect(parseDue('', NOW)).toBeUndefined();
});
