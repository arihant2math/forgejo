// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {count, noun} from './words.ts';

test('counts format numbers and choose singular only for one', () => {
  for (const n of [0, 1, 2, 1234]) {
    expect(count(n, 'issue')).toBe(`${new Intl.NumberFormat().format(n)} ${n === 1 ? 'issue' : 'issues'}`);
  }
  expect(count(2, 'person', 'people')).toBe('2 people');
});

test('nouns support irregular forms without adding the count', () => {
  expect(noun(1, 'branch', 'branches')).toBe('branch');
  expect(noun(0, 'branch', 'branches')).toBe('branches');
  expect(noun(2, 'file')).toBe('files');
});
