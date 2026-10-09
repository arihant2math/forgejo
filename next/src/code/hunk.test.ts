// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {hunkLines} from './hunk.ts';

test('a review comment\'s snippet skips the git and hunk headers (with function context)', () => {
  const patch = [
    'diff --git a/internal/cache/lru.go b/internal/cache/lru.go', 'index 1111111..2222222 100644', '--- a/internal/cache/lru.go', '+++ b/internal/cache/lru.go',
    '@@ -58,3 +56,13 @@ func (c *LRU) Len() int {', ' \tc.mu.Lock()', '-\tdefer c.mu.Unlock()', '+\tdefer c.mu.Unlock() // fixed', '\\ No newline at end of file',
  ].join('\n');
  expect(hunkLines(patch, 4)).toEqual([' \tc.mu.Lock()', '-\tdefer c.mu.Unlock()', '+\tdefer c.mu.Unlock() // fixed']);
  expect(hunkLines('@@ -24,2 +24,3 @@\n a\n+b\n c', 2)).toEqual(['+b', ' c']);
});
