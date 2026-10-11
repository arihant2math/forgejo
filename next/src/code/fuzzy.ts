// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The file finder's fuzzy match (GitHub's "Go to file", `t`): the query's
// letters in order anywhere in a path ("rdme" finds README.md, "srcapp"
// src/app/App.tsx), case-insensitive, whitespace ignored. A match inside
// the file's name beats one spread over directories; word starts ("/", "-",
// "_", ".", camelCase) and consecutive letters score higher; shorter paths
// win ties. One linear pass per path (fzf v1: the first window that holds
// the query, then the shortest one ending there), and each keystroke that
// extends the query only rescans the previous one's matches. Pure.

export interface FuzzyHit {
  path: string;
  score: number;
  /** The indices in `path` of the letters that matched (to mark them). */
  marks: number[];
}

/** A previous search whose matches a longer query is narrowed from. */
export interface FuzzyState {
  query: string;
  /** Indices into the path list (of this list: a new list starts over). */
  matched: readonly number[];
  paths: readonly string[];
}

/** The query as matched: lower case, no whitespace. */
export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, '').toLowerCase();
}

function isSeparator(c: number): boolean {
  // "/", "-", "_", ".", " "
  return c === 47 || c === 45 || c === 95 || c === 46 || c === 32;
}

function isUpper(c: number): boolean {
  return c >= 65 && c <= 90;
}

function isLowerOrDigit(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
}

/** Whether position i of the text starts a word. */
function startsWord(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text.charCodeAt(i - 1);
  return isSeparator(prev) || (isUpper(text.charCodeAt(i)) && isLowerOrDigit(prev));
}

/**
 * The letters of q (normalized) in `lower` from `from` on: the first window that holds them all, shrunk from its
 * end to its shortest; their indices, or undefined.
 */
function span(lower: string, q: string, from: number): number[] | undefined {
  let j = 0;
  let end = -1;
  for (let i = from; i < lower.length; i++) {
    if (lower.charCodeAt(i) === q.charCodeAt(j)) {
      j++;
      if (j === q.length) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return undefined;
  const marks = new Array<number>(q.length);
  let k = q.length - 1;
  for (let i = end; i >= from && k >= 0; i--) {
    if (lower.charCodeAt(i) === q.charCodeAt(k)) marks[k--] = i;
  }
  return marks;
}

/** Scores the letters at `marks` of a path. */
function scoreMarks(path: string, marks: readonly number[], nameStart: number): number {
  let s = 0;
  let prev = -2;
  for (const i of marks) {
    s += 1;
    if (startsWord(path, i)) s += 2;
    if (i === prev + 1) s += 2;
    if (i >= nameStart) s += 1;
    prev = i;
  }
  const first = marks[0] ?? 0;
  const last = marks[marks.length - 1] ?? 0;
  // The letters spread over a long stretch match less well.
  s -= (last - first + 1 - marks.length) * 0.05;
  if (first === nameStart) s += 2;
  return s;
}

/**
 * Matches a normalized query against a path (`lower` is the path in lower case, same length): the hit, or undefined.
 * The file's name is tried first (a match there scores with a bonus), then the whole path.
 */
export function fuzzyMatch(path: string, lower: string, q: string): FuzzyHit | undefined {
  if (!q) return {path, score: 0, marks: []};
  const nameStart = lower.lastIndexOf('/') + 1;
  const inName = nameStart > 0 ? span(lower, q, nameStart) : undefined;
  const marks = inName ?? span(lower, q, 0);
  if (!marks) return undefined;
  let score = scoreMarks(path, marks, nameStart);
  if (inName || nameStart === 0) {
    score += 3;
    if (lower.length - nameStart === q.length) score += 6;
    else if (lower.startsWith(q, nameStart)) score += 3;
  }
  // Shorter paths win ties (a tie-break, never more than a letter's worth).
  return {path, score: score - Math.min(path.length, 400) / 1000, marks};
}

const lowered = new WeakMap<readonly string[], string[]>();

/** The paths in lower case, computed once per list. */
function lowerOf(paths: readonly string[]): string[] {
  let l = lowered.get(paths);
  if (!l) {
    l = paths.map((p) => p.toLowerCase());
    lowered.set(paths, l);
  }
  return l;
}

/** Keeps the `limit` best hits (score, then path), in order, without sorting every match. */
function pushTop(top: FuzzyHit[], hit: FuzzyHit, limit: number): void {
  const worse = (a: FuzzyHit, b: FuzzyHit) => a.score < b.score || (a.score === b.score && a.path > b.path);
  if (top.length === limit) {
    const last = top[limit - 1];
    if (!last || !worse(last, hit)) return;
    top.pop();
  }
  let i = top.length;
  while (i > 0) {
    const p = top[i - 1];
    if (!p || !worse(p, hit)) break;
    i--;
  }
  top.splice(i, 0, hit);
}

/**
 * The best `limit` paths for a query, and the state the next keystroke narrows from. An empty query lists the
 * first paths in their order (git's: by path). `prev`: the previous search, used when this query extends it.
 */
export function findFiles(paths: readonly string[], query: string, limit: number, prev?: FuzzyState): {hits: FuzzyHit[]; state: FuzzyState} {
  const q = normalizeQuery(query);
  if (!q) return {hits: paths.slice(0, limit).map((path) => ({path, score: 0, marks: []})), state: {query: q, matched: [], paths}};
  const lower = lowerOf(paths);
  const narrowed = prev?.paths === paths && prev.query !== '' && q.startsWith(prev.query);
  const top: FuzzyHit[] = [];
  const matched: number[] = [];
  const consider = (i: number) => {
    const path = paths[i];
    const l = lower[i];
    if (path === undefined || l === undefined) return;
    const hit = fuzzyMatch(path, l, q);
    if (!hit) return;
    matched.push(i);
    pushTop(top, hit, limit);
  };
  if (narrowed) for (const i of prev.matched) consider(i);
  else for (let i = 0; i < paths.length; i++) consider(i);
  return {hits: top, state: {query: q, matched, paths}};
}

/** Searches as the user types: each search narrows the previous one's matches when the query extends it. */
export class FileSearcher {
  private prev: FuzzyState | undefined;
  find(paths: readonly string[], query: string, limit: number): FuzzyHit[] {
    const r = findFiles(paths, query, limit, this.prev);
    this.prev = r.state;
    return r.hits;
  }
}

/** A path cut into runs of matched and unmatched letters (for marking them). */
export function markRuns(path: string, marks: readonly number[]): {text: string; marked: boolean}[] {
  const set = new Set(marks);
  const runs: {text: string; marked: boolean}[] = [];
  for (let i = 0; i < path.length; i++) {
    const marked = set.has(i);
    const last = runs[runs.length - 1];
    const c = path.charAt(i);
    if (last?.marked === marked) last.text += c;
    else runs.push({text: c, marked});
  }
  return runs;
}
