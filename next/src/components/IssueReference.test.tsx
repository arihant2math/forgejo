// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen} from '@testing-library/react';
import {expect, test} from 'vitest';
import {formatIssueReference, IssueReference} from './IssueReference.tsx';

test('references consistently separate repository and number, without stray spaces', () => {
  expect(formatIssueReference('dev/fzf', 12)).toBe('dev/fzf #12');
  expect(formatIssueReference('', 12)).toBe('#12');
  expect(formatIssueReference('dev/fzf', undefined)).toBe('dev/fzf');
  expect(formatIssueReference('', undefined)).toBe('');
});

test('the responsive cell keeps the reference muted and its separating space intact', () => {
  render(<IssueReference repo="dev/fzf" number={12}/>);
  const cell = screen.getByTitle('dev/fzf #12');
  expect(cell.textContent).toBe('dev/fzf #12');
  expect(cell.className).toContain('text-sm text-muted');
  expect(screen.getByText('dev/').className).toContain('max-md:hidden');
  expect(screen.getByText('#12').className).toContain('whitespace-pre');
});
