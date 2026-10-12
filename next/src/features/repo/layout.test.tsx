// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen} from '@testing-library/react';
import {expect, test} from 'vitest';
import {DataRow} from './layout.tsx';

test('compact file rows use the directory row height without changing regular resource spacing', () => {
  render(<>
    <DataRow compact href="/dev/fzf/src/branch/master/README.md">README.md</DataRow>
    <DataRow href="/dev/fzf">fzf</DataRow>
  </>);
  const file = screen.getByRole('link', {name: 'README.md'}).parentElement;
  expect(file?.classList.contains('h-row')).toBe(true);
  expect(file?.classList.contains('py-2')).toBe(false);
  expect(file?.classList.contains('px-4')).toBe(true);
  const regular = screen.getByRole('link', {name: 'fzf'}).parentElement;
  expect(regular?.classList.contains('py-2')).toBe(true);
  expect(regular?.classList.contains('h-row')).toBe(false);
});
