// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The ⌘K palette's search over the in-memory pool (PLAN §5.6): repositories
// by full name, issues and pull requests by title, number ("#12", "12") and
// repository. Synchronous, no index: one pass over the pool's entities with
// their lower-cased text cached per state object (states are immutable, so
// a new version gets a new cache entry). Called outside reactions (untracked)
// so that a search does not subscribe to every entity it looked at.

import type {Pool} from '../../data/pool.ts';
import type {Issue, Repository} from '../../protocol/types.gen.ts';

export interface SearchResults {
  repos: Repository[];
  issues: {issue: Issue; repo: Repository | undefined}[];
}

export interface SearchOptions {
  repoLimit?: number;
  issueLimit?: number;
  /** Repositories not in the pool yet (Data.peek). */
  extraRepos?: ReadonlyMap<number, Repository>;
}

const lowered = new WeakMap<object, string>();

function lower(d: object, text: () => string): string {
  let s = lowered.get(d);
  if (s === undefined) {
    s = text().toLowerCase();
    lowered.set(d, s);
  }
  return s;
}

/** The query's terms: lower-cased words; "#12" and "12" also look for issue number 12. */
export function terms(query: string): {words: string[]; number: number | undefined} {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let number: number | undefined;
  for (const w of words) {
    const m = /^#?(\d{1,9})$/.exec(w);
    if (m?.[1]) number = Number(m[1]);
  }
  return {words, number};
}

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const c = text.charCodeAt(i - 1);
  // Not a letter or digit: space, "/", "-", "_", ".", "#", …
  return !((c >= 48 && c <= 57) || (c >= 97 && c <= 122) || c > 127);
}

/** Scores text against words: every word must occur; prefixes and word starts score higher. -1: no match. */
export function score(text: string, words: readonly string[]): number {
  let total = 0;
  for (const w of words) {
    let i = text.indexOf(w);
    if (i < 0) return -1;
    let best = i === 0 ? 3 : isBoundary(text, i) ? 2 : 1;
    while (best < 2 && (i = text.indexOf(w, i + 1)) >= 0) {
      if (isBoundary(text, i)) best = 2;
    }
    total += best;
  }
  return total;
}

interface Ranked<T> {
  item: T;
  score: number;
  updated: string;
}

/** Keeps the `limit` best (score, then most recently updated) without sorting everything. */
function pushTop<T>(top: Ranked<T>[], r: Ranked<T>, limit: number): void {
  if (top.length === limit) {
    const last = top[limit - 1];
    if (!last || r.score < last.score || (r.score === last.score && r.updated <= last.updated)) return;
    top.pop();
  }
  let i = top.length;
  while (i > 0) {
    const p = top[i - 1];
    if (!p || p.score > r.score || (p.score === r.score && p.updated >= r.updated)) break;
    i--;
  }
  top.splice(i, 0, r);
}

export function searchPool(pool: Pool, query: string, opts: SearchOptions = {}): SearchResults {
  const {words, number} = terms(query);
  if (!words.length) return {repos: [], issues: []};
  const repoLimit = opts.repoLimit ?? 6;
  const issueLimit = opts.issueLimit ?? 12;

  const repoStore = pool.model('Repository');
  const repoText = (r: Repository) => lower(r, () => r.full_name);
  const repos: Ranked<Repository>[] = [];
  const seenRepos = new Set<number>();
  const considerRepo = (r: Repository) => {
    seenRepos.add(r.id);
    const s = score(repoText(r), words);
    if (s >= 0) pushTop(repos, {item: r, score: s, updated: r.updated_at}, repoLimit);
  };
  for (const e of repoStore.all()) considerRepo(e.data);
  if (opts.extraRepos) for (const r of opts.extraRepos.values()) if (!seenRepos.has(r.id)) considerRepo(r);

  const repoOf = (id: number): Repository | undefined => repoStore.get(id)?.data ?? opts.extraRepos?.get(id);
  const issues: Ranked<Issue>[] = [];
  // Words other than the number must match the title or the repository's name.
  const textWords = number === undefined ? words : words.filter((w) => !/^#?\d+$/.test(w));
  for (const e of pool.model('Issue').all()) {
    const issue = e.data;
    let s: number;
    if (number !== undefined && issue.number === number) {
      if (!textWords.length) {
        s = 4;
      } else {
        const r = repoOf(issue.repo_id);
        const t = score(`${lower(issue, () => issue.title)} ${r ? repoText(r) : ''}`, textWords);
        if (t < 0) continue;
        s = 4 + t;
      }
    } else {
      s = score(lower(issue, () => issue.title), words);
      if (s < 0) {
        // "repo words + title words": try the repository's name with the title.
        const r = repoOf(issue.repo_id);
        if (!r || words.length < 2) continue;
        s = score(`${lower(issue, () => issue.title)} ${repoText(r)}`, words);
        if (s < 0) continue;
      }
      if (issue.state === 'open') s += 0.5;
    }
    pushTop(issues, {item: issue, score: s, updated: issue.updated_at}, issueLimit);
  }
  return {
    repos: repos.map((r) => r.item),
    issues: issues.map((r) => ({issue: r.item, repo: repoOf(r.item.repo_id)})),
  };
}
