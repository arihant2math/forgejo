// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {abbreviatedCommit} from './refs.ts';

const FULL = `edac59f0a3${'0'.repeat(30)}`;

test('a code path with an abbreviated commit SHA names it and the same path with the full SHA', () => {
  const commit = abbreviatedCommit('commit/edac59f0a3');
  expect(commit?.abbreviation).toBe('edac59f0a3');
  expect(commit?.full(FULL)).toBe(`commit/${FULL}`);
  expect(abbreviatedCommit('src/commit/EDAC59F/internal/geo/projection.go')?.full(FULL)).toBe(`src/commit/${FULL}/internal/geo/projection.go`);
  expect(abbreviatedCommit('src/commit/EDAC59F/x.go')?.abbreviation).toBe('edac59f');
  expect(abbreviatedCommit('blame/commit/edac/a.go')?.full(FULL)).toBe(`blame/commit/${FULL}/a.go`);
  expect(abbreviatedCommit('commits/commit/edac59f')?.full(FULL)).toBe(`commits/commit/${FULL}`);
});

test('anything else is no abbreviation', () => {
  expect(abbreviatedCommit(`commit/${FULL}`)).toBeUndefined();
  expect(abbreviatedCommit(`src/commit/${FULL}/a.go`)).toBeUndefined();
  expect(abbreviatedCommit('commit/edc')).toBeUndefined();
  expect(abbreviatedCommit('commit/main')).toBeUndefined();
  expect(abbreviatedCommit('src/branch/edac59f/a.go')).toBeUndefined();
  expect(abbreviatedCommit('commit/edac59f/extra')).toBeUndefined();
  expect(abbreviatedCommit('src/commit/edac59f/../secret')).toBeUndefined();
  expect(abbreviatedCommit('src/commit')).toBeUndefined();
});
