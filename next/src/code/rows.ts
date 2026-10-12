// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ADD, DEL, type DiffFile} from './diff.ts';
import {lineKey} from './anchor.ts';

export type Row =
  | {t: 'file'; f: number}
  /** The file's comments that are not on a shown line (outdated, outside the hunks). */
  | {t: 'notes'; f: number}
  /** Nothing to show line by line (binary, a mode change, an empty file, too large). */
  | {t: 'empty'; f: number}
  /** A hunk's header; `hidden`: unchanged lines above it that are not shown (they can be expanded). */
  | {t: 'hunk'; f: number; h: number; hidden: number}
  /** Unchanged content expanded above hunk h, numbered on both sides. */
  | {t: 'extra'; f: number; h: number; o: number; n: number; text: string}
  | {t: 'line'; f: number; l: number; right?: number}
  | {t: 'thread'; f: number; l: number};

export interface RowsOptions {
  split?: boolean;
  collapsed?: ReadonlySet<number>;
  /** Unchanged lines shown above a hunk (key `${file}:${hunk}`), counted up from the hunk. */
  revealed?: ReadonlyMap<string, number>;
  /** New-file lines for expanding hidden context. */
  content?: ReadonlyMap<number, readonly string[]>;
  /** Line keys (anchor.ts lineKey) with a thread under them. */
  threads?: ReadonlySet<string>;
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
      const prev = file.hunks[hi - 1];
      const from = prev ? prev.newStart + prev.newLines : 1;
      const gap = Math.max(0, h.newStart - from);
      const lines = o.content?.get(f);
      const shown = lines ? Math.min(gap, o.revealed?.get(`${String(f)}:${String(hi)}`) ?? 0) : 0;
      // Fully revealed gaps merge adjacent hunks.
      if (shown < gap || !prev) rows.push({t: 'hunk', f, h: hi, hidden: gap - shown});
      const delta = h.oldStart - h.newStart;
      for (let n = h.newStart - shown; n < h.newStart; n++) rows.push({t: 'extra', f, h: hi, o: n + delta, n, text: lines?.[n - 1] ?? ''});
      const push = (l: number, right?: number) => {
        rows.push(right === undefined ? {t: 'line', f, l} : {t: 'line', f, l, right});
        for (const index of right === undefined || right === l ? [l] : [l, right]) {
          if (o.threads?.has(lineKey(f, index))) rows.push({t: 'thread', f, l: index});
        }
      };
      for (let l = h.first; l < h.first + h.count; l++) {
        if (!o.split || file.lines[l]?.k !== DEL) {
          push(l);
          continue;
        }
        const deleted: number[] = [];
        const added: number[] = [];
        while (l < h.first + h.count && file.lines[l]?.k === DEL) deleted.push(l++);
        while (l < h.first + h.count && file.lines[l]?.k === ADD) added.push(l++);
        for (let i = 0; i < Math.max(deleted.length, added.length); i++) {
          const left = deleted[i];
          const right = added[i];
          if (left !== undefined) push(left, right);
          else if (right !== undefined) push(right);
        }
        l--;
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
