// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A diff flattened into the rows the virtualized renderer draws (one list
// for the whole pull request): per file a header, then its hunk headers and
// lines, with a thread row under every line that has comments, drafts or an
// open composer, and a notes row for the file's comments that are not on a
// line shown. Collapsed (or viewed) files are their header only. Pure.

import type {DiffFile} from './diff.ts';
import {lineKey} from './anchor.ts';

export type Row =
  | {t: 'file'; f: number}
  /** The file's comments that are not on a shown line (outdated, outside the hunks). */
  | {t: 'notes'; f: number}
  /** Nothing to show line by line (binary, a mode change, an empty file, too large). */
  | {t: 'empty'; f: number}
  /** A hunk's header; `hidden`: unchanged lines above it that are not shown (they can be expanded). */
  | {t: 'hunk'; f: number; h: number; hidden: number}
  /** An unchanged line expanded above hunk `h` (from the file's content): its numbers on both sides, its text. */
  | {t: 'extra'; f: number; h: number; o: number; n: number; text: string}
  | {t: 'line'; f: number; l: number}
  | {t: 'thread'; f: number; l: number};

export interface RowsOptions {
  collapsed?: ReadonlySet<number>;
  /** Unchanged lines shown above a hunk (key `${file}:${hunk}`), counted up from the hunk. */
  revealed?: ReadonlyMap<string, number>;
  /** The new file's lines, for files whose hidden lines were expanded. */
  content?: ReadonlyMap<number, readonly string[]>;
  /** Line keys (anchor.ts lineKey) with a thread under them. */
  threads?: ReadonlySet<string>;
  /** Files with notes. */
  notes?: ReadonlySet<number>;
}

export interface DiffRows {
  rows: Row[];
  /** The row index of each file's header. */
  fileRow: number[];
}

export function diffRows(files: readonly DiffFile[], o: RowsOptions = {}): DiffRows {
  const rows: Row[] = [];
  const fileRow: number[] = [];
  files.forEach((file, f) => {
    fileRow.push(rows.length);
    rows.push({t: 'file', f});
    if (o.collapsed?.has(f)) return;
    if (o.notes?.has(f)) rows.push({t: 'notes', f});
    if (!file.hunks.length) {
      rows.push({t: 'empty', f});
      return;
    }
    file.hunks.forEach((h, hi) => {
      // The unchanged lines between the previous hunk (or the file's start) and this one, in the new file.
      const prev = file.hunks[hi - 1];
      const from = prev ? prev.newStart + prev.newLines : 1;
      const gap = Math.max(0, h.newStart - from);
      const lines = o.content?.get(f);
      const shown = lines ? Math.min(gap, o.revealed?.get(`${String(f)}:${String(hi)}`) ?? 0) : 0;
      // Everything between two hunks shown: they read as one (no header between them).
      if (shown < gap || !prev) rows.push({t: 'hunk', f, h: hi, hidden: gap - shown});
      const delta = h.oldStart - h.newStart;
      for (let n = h.newStart - shown; n < h.newStart; n++) rows.push({t: 'extra', f, h: hi, o: n + delta, n, text: lines?.[n - 1] ?? ''});
      for (let l = h.first; l < h.first + h.count; l++) {
        rows.push({t: 'line', f, l});
        if (o.threads?.has(lineKey(f, l))) rows.push({t: 'thread', f, l});
      }
    });
  });
  return {rows, fileRow};
}

/** The file a row belongs to, given the index of the first row in view (binary search over fileRow). */
export function fileAt(fileRow: readonly number[], row: number): number {
  let lo = 0;
  let hi = fileRow.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((fileRow[mid] ?? 0) <= row) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
