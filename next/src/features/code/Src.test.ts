// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {hashRange} from './Src.tsx';

test('source and blame line links resolve single lines and inclusive ranges', () => {
  expect(hashRange('L8')).toEqual([7, 7]);
  expect(hashRange('#L8-L12')).toEqual([7, 11]);
  expect(hashRange('L12-L8')).toEqual([7, 11]);
  expect(hashRange('L0')).toBeUndefined();
  expect(hashRange('other')).toBeUndefined();
});
