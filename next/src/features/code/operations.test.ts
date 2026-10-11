// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {expect, test} from 'vitest';
import {filePathProblem, UPLOAD_LIMIT} from './operations.ts';
test('new file paths permit folders and reject unsafe segments', () => {
  for (const path of ['docs/new.md', 'hello.txt', '资料/文件.txt']) expect(filePathProblem(path)).toBeUndefined();
  for (const path of ['', '/absolute', 'a//b', 'a/../b', './a', '.git/config', 'a\\b', 'a\n', 'a'.repeat(501)]) expect(filePathProblem(path)).toBeDefined();
  expect(UPLOAD_LIMIT).toBe(10 * 1024 * 1024);
});
