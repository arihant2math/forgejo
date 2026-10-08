// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A line-based 3-way merge (diff3, PLAN §5.4 "Body"): the text the user
// edited from (`base`), the server's current text (`theirs`) and the user's
// text (`mine`). Regions only one side changed take that side; regions both
// changed the same way are taken once; regions both changed differently are a
// conflict, written with git's markers so the user can resolve them in the
// editor. Lines are matched with a longest common subsequence (O(n·m); issue
// bodies are small — beyond MAX_CELLS the texts are compared whole).

export interface MergeResult {
  /** No region conflicts: `text` is the merge. */
  clean: boolean;
  /** The merged text; with conflict markers when not clean. */
  text: string;
  /** The number of conflicting regions. */
  conflicts: number;
}

export const MARK_MINE = '<<<<<<< yours';
export const MARK_SPLIT = '=======';
export const MARK_THEIRS = '>>>>>>> theirs';

/** Above this many cells (lines × lines) the LCS is not computed. */
const MAX_CELLS = 4_000_000;

export function merge3(base: string, theirs: string, mine: string): MergeResult {
  if (mine === theirs || theirs === base) return {clean: true, text: mine, conflicts: 0};
  if (mine === base) return {clean: true, text: theirs, conflicts: 0};
  const o = base.split('\n');
  const a = mine.split('\n');
  const b = theirs.split('\n');
  const ma = matches(o, a);
  const mb = matches(o, b);
  if (!ma || !mb) return conflictWhole(mine, theirs);
  const out: string[] = [];
  let conflicts = 0;
  const chunk = (oi: number, oj: number, ai: number, aj: number, bi: number, bj: number) => {
    const oc = o.slice(oi, oj);
    const ac = a.slice(ai, aj);
    const bc = b.slice(bi, bj);
    if (same(ac, oc)) out.push(...bc);
    else if (same(bc, oc) || same(ac, bc)) out.push(...ac);
    else {
      conflicts++;
      out.push(MARK_MINE, ...ac, MARK_SPLIT, ...bc, MARK_THEIRS);
    }
  };
  let i = 0;
  let ia = 0;
  let ib = 0;
  for (;;) {
    let j = i;
    while (j < o.length && !((ma[j] ?? -1) >= 0 && (mb[j] ?? -1) >= 0)) j++;
    if (j === o.length) {
      if (i < o.length || ia < a.length || ib < b.length) chunk(i, o.length, ia, a.length, ib, b.length);
      break;
    }
    const aj = ma[j] ?? 0;
    const bj = mb[j] ?? 0;
    if (j > i || aj > ia || bj > ib) chunk(i, j, ia, aj, ib, bj);
    out.push(o[j] ?? '');
    i = j + 1;
    ia = aj + 1;
    ib = bj + 1;
  }
  return {clean: conflicts === 0, text: out.join('\n'), conflicts};
}

/** Whether a text still holds conflict markers (an unresolved merge). */
export function hasConflictMarkers(text: string): boolean {
  return text.split('\n').some((l) => l === MARK_MINE || l === MARK_THEIRS);
}

function conflictWhole(mine: string, theirs: string): MergeResult {
  return {clean: false, text: [MARK_MINE, mine, MARK_SPLIT, theirs, MARK_THEIRS].join('\n'), conflicts: 1};
}

function same(x: readonly string[], y: readonly string[]): boolean {
  return x.length === y.length && x.every((l, k) => l === y[k]);
}

/** For each line of `o`, the index of the line of `x` it is matched with by an LCS, or -1. */
function matches(o: readonly string[], x: readonly string[]): Int32Array | undefined {
  // Common prefix and suffix are matched directly (most edits touch a few lines).
  let pre = 0;
  while (pre < o.length && pre < x.length && o[pre] === x[pre]) pre++;
  let suf = 0;
  while (suf < o.length - pre && suf < x.length - pre && o[o.length - 1 - suf] === x[x.length - 1 - suf]) suf++;
  const out = new Int32Array(o.length).fill(-1);
  for (let k = 0; k < pre; k++) out[k] = k;
  for (let k = 0; k < suf; k++) out[o.length - 1 - k] = x.length - 1 - k;
  const n = o.length - pre - suf;
  const m = x.length - pre - suf;
  if (n === 0 || m === 0) return out;
  if (n * m > MAX_CELLS) return undefined;
  // dp[(p)*(m+1)+q] = LCS length of o[pre+p..] and x[pre+q..]
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let p = n - 1; p >= 0; p--) {
    for (let q = m - 1; q >= 0; q--) {
      dp[p * w + q] = o[pre + p] === x[pre + q] ? (dp[(p + 1) * w + q + 1] ?? 0) + 1 : Math.max(dp[(p + 1) * w + q] ?? 0, dp[p * w + q + 1] ?? 0);
    }
  }
  let p = 0;
  let q = 0;
  while (p < n && q < m) {
    if (o[pre + p] === x[pre + q]) {
      out[pre + p] = pre + q;
      p++;
      q++;
    } else if ((dp[(p + 1) * w + q] ?? 0) >= (dp[p * w + q + 1] ?? 0)) p++;
    else q++;
  }
  return out;
}
