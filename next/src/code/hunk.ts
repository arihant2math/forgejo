// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ADD, DEL, type DiffFile, type DiffLine, parseDiff} from './diff.ts';

/**
 * A review comment's stored hunk as a one-file diff at `path`, keeping only its last `max` lines (those around the
 * commented line). Forgejo stores the git headers with it; older or locally made comments may have no headers or
 * no hunk header (their lines then have no numbers).
 */
export function hunkFile(path: string, patch: string, max = Infinity): DiffFile {
  const numbered = /^@@ /m.test(patch);
  const body = numbered ? patch : unnumbered(patch);
  const text = body.startsWith('diff --git ') ? body : `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;
  const file = parseDiff(text)[0] ?? {oldPath: path, newPath: path, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [], lines: []};
  file.oldPath = file.newPath = path;
  file.lines = file.lines.slice(-max);
  if (!numbered) for (const l of file.lines) l.o = l.n = 0;
  return file;
}

/** The diff lines of a patch without a hunk header, behind a header that counts them. */
function unnumbered(patch: string): string {
  const lines = patch.split('\n').filter((l) => /^[ +-]/.test(l) && !/^(?:\+\+\+|---) /.test(l));
  const old = lines.filter((l) => !l.startsWith('+')).length;
  const neu = lines.filter((l) => !l.startsWith('-')).length;
  return `@@ -1,${String(old)} +1,${String(neu)} @@\n${lines.join('\n')}`;
}

/** The lines of a suggested change: the original lines removed, the suggestion added, numbered from `start`. */
export function suggestionFile(path: string, original: readonly string[], suggestion: readonly string[], start: number): DiffFile {
  const lines: DiffLine[] = [
    ...original.map((t, i): DiffLine => ({k: DEL, o: start + i, n: 0, t})),
    ...suggestion.map((t, i): DiffLine => ({k: ADD, o: 0, n: start + i, t})),
  ];
  return {oldPath: path, newPath: path, status: 'modified', binary: false, additions: suggestion.length, deletions: original.length, hunks: [], lines};
}
