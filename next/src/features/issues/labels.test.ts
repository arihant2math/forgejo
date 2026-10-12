// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {labelFill} from './labels.ts';

test('label fills accept colors with or without their hash', () => {
  expect(labelFill('abc123')).toBe('#abc123');
  expect(labelFill('#abc123')).toBe('#abc123');
});
