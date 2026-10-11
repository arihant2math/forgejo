// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {parseDiff} from './diff.ts';
import {diffRows} from './rows.ts';
import {lineKey} from './anchor.ts';
import {CodeSource} from './source.ts';

const files = parseDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,4 @@\n same\n-old\n-old2\n+new\n+new2\n+new3\n');

test('split pairs changes once, keeps original line indices and both threads', () => {
  const {rows, fileRow} = diffRows(files, {split: true, threads: new Set([lineKey(0, 1), lineKey(0, 3)])});
  expect(fileRow).toEqual([0]);
  expect(rows.filter((r) => r.t === 'line')).toEqual([
    {t: 'line', f: 0, l: 0},
    {t: 'line', f: 0, l: 1, right: 3},
    {t: 'line', f: 0, l: 2, right: 4},
    {t: 'line', f: 0, l: 5},
  ]);
  expect(rows.slice(4, 6)).toEqual([{t: 'thread', f: 0, l: 1}, {t: 'thread', f: 0, l: 3}]);
  expect(diffRows(files).rows.filter((r) => r.t === 'line')).toHaveLength(6);
});

test('whitespace variants have independent diff and highlight cache keys', () => {
  expect(CodeSource.diffKey(1, 'base', 'head')).not.toBe(CodeSource.diffKey(1, 'base', 'head', 'ignore-all'));
  expect(CodeSource.diffHlKey(1, 'base', 'head', 0)).not.toBe(CodeSource.diffHlKey(1, 'base', 'head', 0, 'ignore-all'));
});
