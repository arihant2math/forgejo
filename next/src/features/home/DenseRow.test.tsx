// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {cleanup, render} from '@testing-library/react';
import {afterEach, expect, test} from 'vitest';
import {DENSE_ROW_HEIGHT, DenseRow} from './DenseRow.tsx';

afterEach(cleanup);

test('a row is fixed at the height virtual lists estimate for it, with room around its line (#274)', () => {
  const {container} = render(<DenseRow role="presentation">a row</DenseRow>);
  const row = container.firstElementChild;
  // Fixed (not grown by its content): what renders is what the inbox and search virtualizers place.
  expect(row?.classList.contains('h-dense-row')).toBe(true);
  expect(row?.classList.contains('py-2')).toBe(true);
  expect(row?.classList.contains('h-8')).toBe(false);
  // The class's height is the constant: a 21px line (14px text at Primer's 1.5) + 8px above and below + the separator.
  const tokens = readFileSync(join(import.meta.dirname, '../../styles/tokens.css'), 'utf8');
  expect(/--spacing-dense-row:\s*(\d+)px/.exec(tokens)?.[1]).toBe(String(DENSE_ROW_HEIGHT));
  expect(DENSE_ROW_HEIGHT).toBe(21 + 2 * 8 + 1);
});
