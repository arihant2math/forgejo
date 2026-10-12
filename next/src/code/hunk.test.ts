// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {ADD, CTX, DEL} from './diff.ts';
import {hunkFile, suggestionFile} from './hunk.ts';

const rows = (f: {lines: {k: number; o: number; n: number; t: string}[]}) => f.lines.map((l) => [l.k, l.o, l.n, l.t]);

test('a review comment\'s stored hunk, as Forgejo stores it (git headers, function context), keeps its last lines and numbers', () => {
  const patch = [
    'diff --git a/internal/cache/lru.go b/internal/cache/lru.go', 'index 1111111..2222222 100644', '--- a/internal/cache/lru.go', '+++ b/internal/cache/lru.go',
    '@@ -58,3 +56,3 @@ func (c *LRU) Len() int {', ' \tc.mu.Lock()', '-\tdefer c.mu.Unlock()', '+\tdefer c.mu.Unlock() // fixed', ' \treturn c.n', '\\ No newline at end of file',
  ].join('\n');
  const f = hunkFile('internal/cache/lru.go', patch, 3);
  expect(f.newPath).toBe('internal/cache/lru.go');
  expect(rows(f)).toEqual([[DEL, 59, 0, '\tdefer c.mu.Unlock()'], [ADD, 0, 57, '\tdefer c.mu.Unlock() // fixed'], [CTX, 60, 58, '\treturn c.n']]);
});

test('a hunk without git headers takes the comment\'s path; one without a hunk header has no line numbers', () => {
  expect(rows(hunkFile('a.go', '@@ -24,2 +24,3 @@\n a\n+b\n c', 2))).toEqual([[ADD, 0, 25, 'b'], [CTX, 25, 26, 'c']]);
  expect(hunkFile('a.go', '@@ -24,2 +24,3 @@\n a\n+b\n c').newPath).toBe('a.go');
  expect(rows(hunkFile('a.go', ' a\n-b\n+c'))).toEqual([[CTX, 0, 0, 'a'], [DEL, 0, 0, 'b'], [ADD, 0, 0, 'c']]);
});

test('a suggested change removes the original lines and adds the suggestion at the same numbers', () => {
  expect(rows(suggestionFile('a.go', ['x', 'y'], ['z'], 7))).toEqual([[DEL, 7, 0, 'x'], [DEL, 8, 0, 'y'], [ADD, 0, 7, 'z']]);
});
