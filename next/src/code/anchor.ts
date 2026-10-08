// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Review comments on a diff (PLAN §5.7): a comment is anchored by (path,
// side, line, commitSHA). Forgejo stores the side in the sign of `line`
// (negative: the old file's line, positive: the new file's) and the commit
// the comment was made on; when a later push changes the lines around it,
// Forgejo marks it `invalidated` ("outdated"). Pure.
//
// A comment shows on a diff line when its path is a file of the diff, its
// side and line number match a line shown (a removed or context line for the
// old side, an added or context line for the new one) and it is not
// outdated. Everything else is listed with its file (outdated, or a line
// outside the hunks shown) or, for a path not in the diff, apart.

import {ADD, DEL, type DiffFile, filePath} from './diff.ts';

export type Side = 'old' | 'new';

export interface Anchor {
  path: string;
  side: Side;
  /** 1-based line number on that side. */
  line: number;
  /** The commit the comment was made on (the head the user saw). */
  commit: string;
}

/** The anchor of a Forgejo code comment (Comment.line's sign is the side). */
export function commentAnchor(c: {path: string; line: number; commit_id: string}): Anchor {
  return {path: c.path, side: c.line < 0 ? 'old' : 'new', line: Math.abs(c.line), commit: c.commit_id};
}

/** Forgejo's signed line of an anchor (API v1: old_position or new_position). */
export function signedLine(a: Pick<Anchor, 'side' | 'line'>): number {
  return a.side === 'old' ? -a.line : a.line;
}

/** The anchor of a diff line, commented on its natural side: removed lines on the old side, the rest on the new. */
export function lineAnchor(file: DiffFile, index: number, commit: string): Anchor | undefined {
  const l = file.lines[index];
  if (!l) return undefined;
  return l.k === DEL ? {path: filePath(file), side: 'old', line: l.o, commit} : {path: filePath(file), side: 'new', line: l.n, commit};
}

export interface Anchored<T> {
  /** Items on a line: key `${fileIndex}:${lineIndex}`, in input order. */
  lines: Map<string, T[]>;
  /** Items of a file of the diff that are not on a line shown (outdated, or outside the hunks), by file index. */
  files: Map<number, T[]>;
  /** Items whose path is not in the diff. */
  elsewhere: T[];
}

export function lineKey(file: number, line: number): string {
  return `${String(file)}:${String(line)}`;
}

/**
 * Places items (comments, drafts) on a diff. `outdated(item)`: Forgejo
 * invalidated it (only items made on another commit than `head` can be).
 */
export function anchor<T>(files: readonly DiffFile[], items: readonly T[], of: (item: T) => Anchor, head: string, outdated: (item: T) => boolean = () => false): Anchored<T> {
  const out: Anchored<T> = {lines: new Map(), files: new Map(), elsewhere: []};
  if (!items.length) return out;
  const byPath = new Map<string, number>();
  files.forEach((f, i) => {
    byPath.set(filePath(f), i);
    // A renamed file's comments made before the rename name its old path.
    if (f.oldPath !== f.newPath && !byPath.has(f.oldPath)) byPath.set(f.oldPath, i);
  });
  // Line lookup per (file, side), built only for files that have items.
  const index = new Map<number, {old: Map<number, number>; new: Map<number, number>}>();
  const lookup = (fi: number) => {
    let ix = index.get(fi);
    if (ix) return ix;
    ix = {old: new Map(), new: new Map()};
    const lines = files[fi]?.lines ?? [];
    for (let li = 0; li < lines.length; li++) {
      const l = lines[li];
      if (!l) continue;
      // A removed line wins over a context line with the same old number (there is none in one diff, but be exact).
      if (l.k !== ADD && (l.k === DEL || !ix.old.has(l.o))) ix.old.set(l.o, li);
      if (l.k !== DEL) ix.new.set(l.n, li);
    }
    index.set(fi, ix);
    return ix;
  };
  const push = <K>(m: Map<K, T[]>, k: K, item: T) => {
    const list = m.get(k);
    if (list) list.push(item);
    else m.set(k, [item]);
  };
  for (const item of items) {
    const a = of(item);
    const fi = byPath.get(a.path);
    if (fi === undefined) {
      out.elsewhere.push(item);
      continue;
    }
    // Made on another commit and invalidated since: the lines moved or changed.
    if (a.commit !== head && outdated(item)) {
      push(out.files, fi, item);
      continue;
    }
    // A comment made on the old path of a renamed file names that path's lines only on the old side.
    const f = files[fi];
    const onOldPath = f !== undefined && f.oldPath !== f.newPath && a.path === f.oldPath && a.path !== filePath(f);
    const li = onOldPath && a.side === 'new' ? undefined : lookup(fi)[a.side].get(a.line);
    if (li === undefined) push(out.files, fi, item);
    else push(out.lines, lineKey(fi, li), item);
  }
  return out;
}
