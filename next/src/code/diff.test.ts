// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import fc from 'fast-check';
import {describe, expect, test} from 'vitest';
import {ADD, CTX, DEL, diffStats, filePath, parseDiff, unquote} from './diff.ts';

// `git diff -M` of a real repository (src/test/fixtures/sample.diff): a modified file with two hunks, a binary
// file, a new file with a quoted UTF-8 name, a new file whose line starts with "--", a mode change, a rename with
// an edit, a change without a final newline, and a deleted file whose name has a space.
const sample = readFileSync(resolve(process.cwd(), 'src/test/fixtures/sample.diff'), 'utf8');

describe('parseDiff', () => {
  const files = parseDiff(sample);
  const by = (p: string) => files.find((f) => filePath(f) === p);

  test('files, paths and statuses', () => {
    expect(files.map((f) => [f.oldPath, f.newPath, f.status, f.binary])).toEqual([
      ['a.txt', 'a.txt', 'modified', false],
      ['bin.dat', 'bin.dat', 'modified', true],
      ['café.txt', 'café.txt', 'added', false],
      ['dash.txt', 'dash.txt', 'added', false],
      ['mode.sh', 'mode.sh', 'modified', false],
      ['move.txt', 'moved.txt', 'renamed', false],
      ['noeol.txt', 'noeol.txt', 'modified', false],
      ['sp ace.txt', 'sp ace.txt', 'deleted', false],
    ]);
    expect(by('mode.sh')).toMatchObject({oldMode: '100644', newMode: '100755', hunks: []});
  });

  test('hunks and line numbers', () => {
    const a = by('a.txt');
    expect(a?.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines, h.section, h.first, h.count])).toEqual([
      [1, 5, 1, 5, '', 0, 6],
      [8, 3, 8, 4, 'seven', 6, 4],
    ]);
    expect(a?.lines.slice(0, 3)).toEqual([
      {k: CTX, o: 1, n: 1, t: 'one'},
      {k: DEL, o: 2, n: 0, t: 'two'},
      {k: ADD, o: 0, n: 2, t: 'TWO'},
    ]);
    expect(a?.lines.at(-1)).toEqual({k: ADD, o: 0, n: 11, t: 'eleven'});
    expect([a?.additions, a?.deletions]).toEqual([2, 1]);
    expect(by('moved.txt')?.lines.map((l) => [l.k, l.o, l.n])).toEqual([[CTX, 28, 28], [CTX, 29, 29], [CTX, 30, 30], [ADD, 0, 31]]);
  });

  test('a content line that looks like a header stays content', () => {
    expect(by('dash.txt')?.lines).toEqual([{k: ADD, o: 0, n: 1, t: '-- dashes'}]);
  });

  test('no newline at end of file', () => {
    expect(by('noeol.txt')?.lines).toEqual([{k: DEL, o: 1, n: 0, t: 'x', noEol: true}, {k: ADD, o: 0, n: 1, t: 'y', noEol: true}]);
  });

  test('deleted file with a space (the tab git appends is not part of the name)', () => {
    expect(by('sp ace.txt')?.lines).toEqual([{k: DEL, o: 1, n: 0, t: 'hi'}]);
  });

  test('stats', () => {
    expect(diffStats(files)).toEqual({files: 8, additions: 6, deletions: 3, lines: 19});
  });

  test('empty and garbage input', () => {
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('hello\nworld\n')).toEqual([]);
  });

  test('a cut diff keeps what it has', () => {
    const cut = sample.slice(0, sample.indexOf('+eleven'));
    const a = parseDiff(cut)[0];
    expect(a?.hunks[1]?.count).toBe(3);
  });

  test('binary file without ---/+++ takes paths from the header', () => {
    const f = parseDiff('diff --git a/x y.png b/x y.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/x y.png differ\n')[0];
    expect(f).toMatchObject({oldPath: 'x y.png', newPath: 'x y.png', status: 'added', binary: true});
  });

  test('CRLF content lines keep their carriage return; header lines lose it', () => {
    const f = parseDiff('diff --git a/w b/w\r\n--- a/w\r\n+++ b/w\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n')[0];
    expect(f?.newPath).toBe('w');
    expect(f?.lines.map((l) => l.t)).toEqual(['a\r', 'b\r']);
  });

  test('property: line numbers advance consistently in every hunk', () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.constantFrom(' ', '+', '-'), fc.string({maxLength: 6}).map((s) => s.replace(/[\r\n]/g, ''))), {minLength: 1, maxLength: 40}), (body) => {
      const oldN = body.filter(([c]) => c !== '+').length;
      const newN = body.filter(([c]) => c !== '-').length;
      const text = `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -5,${String(oldN)} +7,${String(newN)} @@\n${body.map(([c, t]) => c + t).join('\n')}\n`;
      const f = parseDiff(text)[0];
      expect(f?.lines.length).toBe(body.length);
      let o = 5;
      let n = 7;
      for (const l of f?.lines ?? []) {
        if (l.k !== ADD) expect(l.o).toBe(o++);
        if (l.k !== DEL) expect(l.n).toBe(n++);
      }
    }));
  });
});

test('unquote: C-style escapes and UTF-8 octets', () => {
  expect(unquote('"a/caf\\303\\251.txt"')).toBe('a/café.txt');
  expect(unquote('"tab\\there\\"q\\\\"')).toBe('tab\there"q\\');
  expect(unquote('plain')).toBe('plain');
});

test('a hunk shorter than its header does not swallow the next file', () => {
  const f = parseDiff('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n x\ndiff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-1\n+2\n');
  expect(f.map((x) => [x.newPath, x.lines.length])).toEqual([['a.txt', 1], ['b.txt', 2]]);
});
