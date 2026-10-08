// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The virtualizers position rows by these heights without measuring them: they must be the tokens' sizes.

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {expect, test} from 'vitest';
import {FILE_ROW} from './DiffView.tsx';
import {LINE} from './Lines.tsx';
import {ROW} from './RowList.tsx';

const tokens = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');
const px = (name: string) => Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(tokens)?.[1]);

test('row heights match the design tokens', () => {
  expect(LINE).toBe(px('--spacing-line'));
  expect(LINE).toBe(px('--text-code--line-height'));
  expect(ROW).toBe(px('--spacing-row'));
  // A file header: an h-row header after a p-2 gap (2 × the 4 px spacing step).
  expect(FILE_ROW).toBe(px('--spacing-row') + 2 * px('--spacing'));
});
