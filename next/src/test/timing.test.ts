// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {measure} from './timing.ts';

test('time the thread does not run (a loaded machine scheduling others) is not counted as cost (#288)', () => {
  // Blocked for 60 ms without using the CPU, as a thread waiting for one would be.
  const {value, ms} = measure(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60));
  expect(value).toBe('timed-out');
  expect(ms).toBeLessThan(20);
});

test('the work\'s result comes back with its cost', () => {
  const {value, ms} = measure(() => [3, 1, 2].sort((a, b) => a - b));
  expect(value).toEqual([1, 2, 3]);
  expect(ms).toBeGreaterThanOrEqual(0);
});
