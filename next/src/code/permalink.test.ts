// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {permalink} from './permalink.ts';

test('permalinks pin the commit, encode path segments and preserve line anchors', () => {
  expect(permalink('a b', 'repo', 'abc123', 'src/a b.ts', '#L12-L20')).toBe('/a%20b/repo/src/commit/abc123/src/a%20b.ts#L12-L20');
  expect(permalink('a', 'r', 'sha', 'file', 'L2')).toBe('/a/r/src/commit/sha/file#L2');
  expect(permalink('a', 'r', 'sha', 'file', '#invalid')).toBe('/a/r/src/commit/sha/file');
  expect(permalink('a', 'r', 'sha', 'file')).toBe('/a/r/src/commit/sha/file');
});
