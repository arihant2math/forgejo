// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A unified diff (`git diff -M`, as B9's /diff endpoints stream it) parsed
// into files, hunks and lines. Pure and allocation-light: it runs in the
// code worker (workers/code.worker.ts) for a whole pull request at once,
// and the renderer (features/pull) walks the result by index.
//
// Paths come from `---`/`+++` and `rename from/to` lines (unambiguous, C-quoted
// when git quotes them); the `diff --git` header is only used for files that
// have neither (mode changes, binary files, empty new files).

/** A line's kind: context, added, removed. */
export const CTX = 0;
export const ADD = 1;
export const DEL = 2;
export type LineKind = typeof CTX | typeof ADD | typeof DEL;

export interface DiffLine {
  k: LineKind;
  /** Line number in the old file (0 for an added line). */
  o: number;
  /** Line number in the new file (0 for a removed line). */
  n: number;
  /** The text without its +/-/space prefix. */
  t: string;
  /** The file has no newline after this line ("\ No newline at end of file"). */
  noEol?: true;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the second @@ (the enclosing function, when git finds one). */
  section: string;
  /** Index of the hunk's first line in DiffFile.lines. */
  first: number;
  count: number;
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  binary: boolean;
  oldMode?: string;
  newMode?: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  lines: DiffLine[];
}

/** The path a file is known by in the pull request (its new path; the old one when deleted). */
export function filePath(f: Pick<DiffFile, 'oldPath' | 'newPath' | 'status'>): string {
  return f.status === 'deleted' ? f.oldPath : f.newPath;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** Parses a unified diff. Never throws: unrecognised lines are skipped. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | undefined;
  let header = '';
  let hunk: DiffHunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let o = 0;
  let n = 0;
  const end = text.length;
  let pos = 0;
  while (pos < end) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = end;
    let line = text.slice(pos, nl);
    pos = nl + 1;
    if (line.endsWith('\r') && !hunk) line = line.slice(0, -1);
    // Inside a hunk the counts say how many lines belong to it, so a content line that looks like a header
    // ("--- a" removed from a file whose line is "-- a") is never taken for one.
    if (f && hunk && (oldLeft > 0 || newLeft > 0)) {
      const c = line.charCodeAt(0);
      const t = line.slice(1);
      if (c === 32 /* ' ' */ || line === '') {
        f.lines.push({k: CTX, o: o++, n: n++, t});
        oldLeft--;
        newLeft--;
      } else if (c === 43 /* + */) {
        f.lines.push({k: ADD, o: 0, n: n++, t});
        f.additions++;
        newLeft--;
      } else if (c === 45 /* - */) {
        f.lines.push({k: DEL, o: o++, n: 0, t});
        f.deletions++;
        oldLeft--;
      } else if (c === 92 /* \ */) {
        markNoEol(f);
        continue;
      } else {
        // Malformed: end the hunk and read the line as a header.
        oldLeft = newLeft = 0;
      }
      if (oldLeft > 0 || newLeft > 0) continue;
      hunk.count = f.lines.length - hunk.first;
      continue;
    }
    if (line.startsWith('\\') && f) {
      markNoEol(f);
      continue;
    }
    if (line.startsWith('diff --git ')) {
      if (f) finish(f, header);
      header = line.slice('diff --git '.length);
      f = {oldPath: '', newPath: '', status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [], lines: []};
      files.push(f);
      hunk = undefined;
      continue;
    }
    if (!f) continue;
    const m = HUNK.exec(line);
    if (m) {
      oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      newLeft = m[4] === undefined ? 1 : Number(m[4]);
      o = Number(m[1]);
      n = Number(m[3]);
      // An empty side starts at 0 in git's notation ("-0,0"): its first line would be 1.
      if (oldLeft === 0 && o === 0) o = 1;
      if (newLeft === 0 && n === 0) n = 1;
      hunk = {oldStart: Number(m[1]), oldLines: oldLeft, newStart: Number(m[3]), newLines: newLeft, section: m[5] ?? '', first: f.lines.length, count: 0};
      f.hunks.push(hunk);
      continue;
    }
    if (hunk) continue; // stray text after a complete hunk
    if (line.startsWith('--- ')) {
      const p = diffPath(line.slice(4));
      if (p === null) f.status = 'added';
      else f.oldPath = p;
    } else if (line.startsWith('+++ ')) {
      const p = diffPath(line.slice(4));
      if (p === null) f.status = 'deleted';
      else f.newPath = p;
    } else if (line.startsWith('rename from ')) {
      f.oldPath = unquote(line.slice('rename from '.length));
      f.status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      f.newPath = unquote(line.slice('rename to '.length));
      f.status = 'renamed';
    } else if (line.startsWith('copy from ')) {
      f.oldPath = unquote(line.slice('copy from '.length));
      f.status = 'copied';
    } else if (line.startsWith('copy to ')) {
      f.newPath = unquote(line.slice('copy to '.length));
      f.status = 'copied';
    } else if (line.startsWith('new file mode ')) {
      f.status = 'added';
      f.newMode = line.slice('new file mode '.length);
    } else if (line.startsWith('deleted file mode ')) {
      f.status = 'deleted';
      f.oldMode = line.slice('deleted file mode '.length);
    } else if (line.startsWith('old mode ')) {
      f.oldMode = line.slice('old mode '.length);
    } else if (line.startsWith('new mode ')) {
      f.newMode = line.slice('new mode '.length);
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      f.binary = true;
    }
  }
  if (f) finish(f, header);
  return files;
}

function markNoEol(f: DiffFile): void {
  const last = f.lines.at(-1);
  if (last) last.noEol = true;
}

/** Fills in paths the ---/+++ lines did not give (from the header) and the other side of added/deleted files. */
function finish(f: DiffFile, header: string): void {
  // Counts from the positions (a cut diff leaves the last hunk short).
  f.hunks.forEach((h, i) => {
    h.count = (f.hunks[i + 1]?.first ?? f.lines.length) - h.first;
  });
  if (!f.oldPath || !f.newPath) {
    const [a, b] = headerPaths(header);
    if (!f.oldPath) f.oldPath = f.status === 'added' && f.newPath ? f.newPath : a;
    if (!f.newPath) f.newPath = f.status === 'deleted' && f.oldPath ? f.oldPath : b;
  }
  if (f.status === 'added' && !f.oldPath) f.oldPath = f.newPath;
  if (f.status === 'deleted' && !f.newPath) f.newPath = f.oldPath;
}

/** A path on a ---/+++ line: null for /dev/null; the a/ or b/ prefix removed. */
function diffPath(s: string): string | null {
  // git appends a tab after a path containing spaces in some modes.
  const raw = s.endsWith('\t') ? s.slice(0, -1) : s;
  if (raw === '/dev/null') return null;
  const p = unquote(raw);
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The two paths of a `diff --git a/x b/y` header (exact when both are quoted or both are the same path). */
function headerPaths(h: string): [string, string] {
  if (h.startsWith('"')) {
    const end = quotedEnd(h, 0);
    const a = unquote(h.slice(0, end));
    const rest = h.slice(end + 1);
    return [strip(a), strip(unquote(rest))];
  }
  if (h.endsWith('"')) {
    const start = h.lastIndexOf(' "');
    return [strip(h.slice(0, start)), strip(unquote(h.slice(start + 1)))];
  }
  // "a/P b/P": the same path twice when the file was not renamed (renames have rename from/to lines).
  if ((h.length - 5) % 2 === 0) {
    const half = (h.length - 1) / 2;
    const a = h.slice(0, half);
    const b = h.slice(half + 1);
    if (a.slice(2) === b.slice(2)) return [strip(a), strip(b)];
  }
  const sp = h.indexOf(' b/');
  return sp < 0 ? [strip(h), strip(h)] : [strip(h.slice(0, sp)), strip(h.slice(sp + 1))];
}

function strip(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function quotedEnd(s: string, start: number): number {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i + 1;
  }
  return s.length;
}

const ESCAPES: Record<string, number> = {a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92};

/** Undoes git's C-style path quoting ("a/caf\303\251" → a/café); other strings are returned as they are. */
export function unquote(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i] ?? '';
    if (c !== '\\') {
      // Copy one code point as UTF-8.
      const cp = s.codePointAt(i) ?? 0;
      const ch = String.fromCodePoint(cp);
      bytes.push(...enc.encode(ch));
      i += ch.length - 1;
      continue;
    }
    const e = s[++i] ?? '';
    if (/[0-7]/.test(e)) {
      const oct = s.slice(i, i + 3);
      bytes.push(Number.parseInt(oct, 8) & 0xff);
      i += oct.length - 1;
    } else {
      bytes.push(ESCAPES[e] ?? e.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Totals over a diff. */
export function diffStats(files: readonly DiffFile[]): {files: number; additions: number; deletions: number; lines: number} {
  let additions = 0;
  let deletions = 0;
  let lines = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
    lines += f.lines.length;
  }
  return {files: files.length, additions, deletions, lines};
}
