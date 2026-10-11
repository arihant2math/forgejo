// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {dueOptions, parseDue} from './Picker.tsx';

// A Wednesday.
const NOW = new Date(2026, 9, 7, 15, 30).getTime();

test('due date presets: today, tomorrow, Friday, a week, two weeks, a month', () => {
  expect(dueOptions(NOW).map((o) => o.day)).toEqual(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-14', '2026-10-21', '2026-11-07']);
});

test('next week stays seven days away on Sunday', () => {
  const presets = dueOptions(new Date(2026, 9, 11).getTime());
  expect(presets.find((o) => o.label === 'Tomorrow')?.day).toBe('2026-10-12');
  expect(presets.find((o) => o.label === 'Next week')?.day).toBe('2026-10-18');
});

test('on a Friday or a weekend there is no "End of this week" (it is today, or past): in date order', () => {
  const sunday = new Date(2026, 9, 11, 10).getTime();
  expect(dueOptions(sunday).map((o) => `${o.label} ${o.day}`)).toEqual([
    'Today 2026-10-11', 'Tomorrow 2026-10-12', 'Next week 2026-10-18', 'In two weeks 2026-10-25', 'In a month 2026-11-11',
  ]);
  expect(dueOptions(new Date(2026, 9, 9, 10).getTime()).map((o) => o.label)).not.toContain('End of this week');
  expect(dueOptions(new Date(2026, 9, 10, 10).getTime()).map((o) => o.label)).not.toContain('End of this week');
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
