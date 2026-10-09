// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {anchor, commentAnchor, lineAnchor, lineKey, signedLine} from './anchor.ts';
import {parseDiff} from './diff.ts';

const HEAD = 'b'.repeat(40);
const OLD = 'a'.repeat(40);

// a.txt: hunk 1 = ctx one(1,1), del two(2,-), add TWO(-,2), ctx three(3,3)…; renamed old.txt → new.txt.
const files = parseDiff([
  'diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1,4 +1,4 @@', ' one', '-two', '+TWO', ' three', ' four',
  '@@ -20,2 +20,3 @@', ' twenty', '+added', ' twenty-one',
  'diff --git a/old.txt b/new.txt', 'similarity index 90%', 'rename from old.txt', 'rename to new.txt', '--- a/old.txt', '+++ b/new.txt',
  '@@ -1,2 +1,2 @@', '-x', '+y', ' z', '',
].join('\n'));

interface C {id: number; path: string; line: number; commit_id: string; invalidated: boolean}
const c = (id: number, path: string, line: number, commit = HEAD, invalidated = false): C => ({id, path, line, commit_id: commit, invalidated});

test('comments land on the line of their side', () => {
  const r = anchor(files, [
    c(1, 'a.txt', -2), // old side: the removed "two" (index 1)
    c(2, 'a.txt', 2), // new side: the added "TWO" (index 2)
    c(3, 'a.txt', 3), // context "three", new side (index 3)
    c(4, 'a.txt', -3), // context "three", old side (index 3 too)
    c(5, 'a.txt', 21), // added in hunk 2 (index 6)
  ], commentAnchor, HEAD, (x) => x.invalidated);
  expect([...r.lines].map(([k, v]) => [k, v.map((x) => x.id)])).toEqual([
    [lineKey(0, 1), [1]], [lineKey(0, 2), [2]], [lineKey(0, 3), [3, 4]], [lineKey(0, 6), [5]],
  ]);
  expect(r.files.size).toBe(0);
  expect(r.elsewhere).toEqual([]);
});

test('outdated comments and lines outside the hunks stay with their file; other paths apart', () => {
  const r = anchor(files, [
    c(1, 'a.txt', 2, OLD, true), // made on an older commit, invalidated
    c(2, 'a.txt', 2, OLD, false), // older commit, still valid: on its line
    c(3, 'a.txt', 10), // line 10 is not in a hunk
    c(4, 'a.txt', -21), // old line 21 is context in hunk 2 → shown
    c(5, 'gone.txt', 1),
    c(6, 'a.txt', 2, HEAD, true), // invalidated flags on the head commit itself mean nothing
  ], commentAnchor, HEAD, (x) => x.invalidated);
  expect(r.files.get(0)?.map((x) => x.id)).toEqual([1, 3]);
  expect(r.lines.get(lineKey(0, 2))?.map((x) => x.id)).toEqual([2, 6]);
  expect(r.lines.get(lineKey(0, 7))?.map((x) => x.id)).toEqual([4]);
  expect(r.elsewhere.map((x) => x.id)).toEqual([5]);
});

test('renamed files: comments on the old path show on the old side only', () => {
  const r = anchor(files, [c(1, 'old.txt', -1), c(2, 'new.txt', 1), c(3, 'old.txt', 2)], commentAnchor, HEAD);
  expect(r.lines.get(lineKey(1, 0))?.map((x) => x.id)).toEqual([1]);
  expect(r.lines.get(lineKey(1, 1))?.map((x) => x.id)).toEqual([2]);
  expect(r.files.get(1)?.map((x) => x.id)).toEqual([3]);
});

test('a line\'s natural anchor round-trips through Forgejo\'s signed line', () => {
  const f = files[0];
  if (!f) throw new Error('no file');
  for (let i = 0; i < f.lines.length; i++) {
    const a = lineAnchor(f, i, HEAD);
    if (!a) throw new Error('no anchor');
    const back = commentAnchor({path: a.path, line: signedLine(a), commit_id: HEAD});
    expect(back).toEqual(a);
    expect(anchor(files, [back], (x) => x, HEAD).lines.get(lineKey(0, i))).toEqual([back]);
  }
  // Removed lines are commented on the old side, the rest on the new.
  expect(lineAnchor(f, 1, HEAD)?.side).toBe('old');
  expect(lineAnchor(f, 0, HEAD)?.side).toBe('new');
});

test('diff rows: headers, hunks, lines, threads, notes, collapsed files; fileAt', async () => {
  const {diffRows, fileAt} = await import('./rows.ts');
  const r = diffRows(files, {threads: new Set([lineKey(0, 1)]), notes: new Set([1]), collapsed: new Set()});
  expect(r.rows.slice(0, 4)).toEqual([{t: 'file', f: 0}, {t: 'hunk', f: 0, h: 0}, {t: 'line', f: 0, l: 0}, {t: 'line', f: 0, l: 1}]);
  expect(r.rows[4]).toEqual({t: 'thread', f: 0, l: 1});
  const second = r.fileRow[1] ?? -1;
  expect(r.rows[second]).toEqual({t: 'file', f: 1});
  expect(r.rows[second + 1]).toEqual({t: 'notes', f: 1});
  expect(r.rows.filter((x) => x.t === 'line')).toHaveLength(files.reduce((n, f) => n + f.lines.length, 0));
  expect(fileAt(r.fileRow, 0)).toBe(0);
  expect(fileAt(r.fileRow, second - 1)).toBe(0);
  expect(fileAt(r.fileRow, second)).toBe(1);
  expect(fileAt(r.fileRow, 10_000)).toBe(1);
  const c = diffRows(files, {collapsed: new Set([0])});
  expect(c.rows[0]).toEqual({t: 'file', f: 0});
  expect(c.rows[1]).toEqual({t: 'file', f: 1});
  // A file without hunks (binary, mode change) has an "empty" row.
  expect(diffRows(parseDiff('diff --git a/b.png b/b.png\nBinary files a/b.png and b/b.png differ\n')).rows).toEqual([{t: 'file', f: 0}, {t: 'empty', f: 0}]);
});
