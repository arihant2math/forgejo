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
  | {t: 'hunk'; f: number; h: number}
  | {t: 'line'; f: number; l: number}
  | {t: 'thread'; f: number; l: number};

export interface RowsOptions {
  collapsed?: ReadonlySet<number>;
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
      rows.push({t: 'hunk', f, h: hi});
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
