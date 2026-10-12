// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {parsePatchFiles} from '@pierre/diffs';
import {parseDiff, type DiffFile} from './diff.ts';
import {pierrePatch} from './pierrePatch.ts';

function convert(patch: string) {
  const file = parseDiff(patch)[0];
  if (!file) throw new Error('no file');
  return parsePatchFiles(pierrePatch(file))[0]?.files[0];
}

test('partial server hunks retain old/new coordinates and no-newline markers', () => {
  const diff = convert('diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -40,2 +40,3 @@ function hello\n context\n-old\n+new\n+added\n\\ No newline at end of file\n');
  expect(diff?.hunks[0]?.deletionStart).toBe(40);
  expect(diff?.hunks[0]?.additionStart).toBe(40);
  expect(diff?.hunks[0]?.additionCount).toBe(3);
  expect(diff?.hunks[0]?.hunkContext).toBe('function hello');
  expect(diff?.additionLines.join('')).toContain('added');
});

test('added and deleted files retain their change type', () => {
  const patch = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n';
  expect(convert(patch)?.type).toBe('new');
  expect(convert('diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n')?.type).toBe('deleted');
});

test('empty, binary, mode-only, renamed and unusual paths are convertible', () => {
  const file: DiffFile = {oldPath: 'café space.txt', newPath: 'renamed.txt', status: 'renamed', binary: false, additions: 0, deletions: 0, hunks: [], lines: [], oldMode: '100644', newMode: '100755'};
  const parsed = parsePatchFiles(pierrePatch(file))[0]?.files[0];
  expect(parsed).toBeDefined();
  expect(pierrePatch(file)).toContain('old mode 100644\nnew mode 100755');
  for (const variant of [{...file, status: 'modified' as const}, {...file, binary: true}, {...file, status: 'added' as const}]) expect(parsePatchFiles(pierrePatch(variant))[0]?.files[0]).toBeDefined();
});
