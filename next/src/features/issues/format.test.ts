// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {ago, agoWords} from './format.ts';

const NOW = Date.parse('2026-10-08T12:00:00Z');

test('compact relative times have no day or full year for earlier years (they fit the rows\' fixed slot)', () => {
  expect(ago('2026-10-08T11:59:30Z', NOW)).toBe('now');
  expect(ago('2026-10-08T11:15:00Z', NOW)).toBe('45m');
  expect(ago('2026-10-06T12:00:00Z', NOW)).toBe('2d');
  expect(ago('2026-03-03T12:00:00Z', NOW)).toMatch(/^\S+ \d{1,2}$/);
  const old = ago('2024-10-12T12:00:00Z', NOW);
  expect(old).toMatch(/’24$/);
  expect(agoWords('2024-10-12T12:00:00Z', NOW)).toMatch(/^on .*2024$/);
});
