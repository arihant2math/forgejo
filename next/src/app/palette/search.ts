// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Cache lower-cased text by immutable state object; callers must search untracked to avoid entity subscriptions.

import type {Pool} from '../../data/pool.ts';
import type {Issue, Repository} from '../../protocol/types.gen.ts';

export interface SearchResults {
  repos: Repository[];
  issues: {issue: Issue; repo: Repository | undefined}[];
  /** The best scores (repositories, issues), for ranking the palette's groups against each other; -1 when none. */
  top?: {repos: number; issues: number};
  /** Issues the query names exactly ("atlas#85", "acme/atlas#1", "#12" in the repository on screen): first. */
  exact?: {issue: Issue; repo: Repository | undefined}[];
  /** Every issue that matched (undefined when too many to keep): the candidates of a narrower query. */
  matched?: Issue[] | undefined;
}

export interface Narrowing {
  query: string;
  matched: readonly Issue[];
}

const KEEP = 20_000;

export interface SearchOptions {
  repoLimit?: number;
  issueLimit?: number;
  /** Repositories not in the pool yet (Data.peek). */
  extraRepos?: ReadonlyMap<number, Repository>;
  /** The repository on screen: a bare "#12" names its issue exactly. */
  contextRepo?: number | undefined;
  /** Narrows an extending query to prior matches; intervening deltas appear on the next full scan. */
  narrow?: Narrowing | undefined;
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

export interface IssueRef {
  owner?: string | undefined;
  repo: string;
  number: number;
}

/** Lower-cases terms; accepts bare numbers and repo#number references. */
export function terms(query: string): {words: string[]; number: number | undefined; ref?: IssueRef} {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let number: number | undefined;
  let ref: IssueRef | undefined;
  for (const w of words) {
    const m = /^#?(\d{1,9})$/.exec(w);
    if (m?.[1]) number = Number(m[1]);
    const r = /^(?:([\w.-]+)\/)?([\w.-]+)#(\d{1,9})$/.exec(w);
    if (r?.[2] && r[3]) ref = {owner: r[1], repo: r[2], number: Number(r[3])};
  }
  return ref ? {words, number, ref} : {words, number};
}

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const c = text.charCodeAt(i - 1);
  return !((c >= 48 && c <= 57) || (c >= 97 && c <= 122) || c > 127);
}

function wordScore(text: string, w: string): number {
  let i = text.indexOf(w);
  if (i < 0) return -1;
  let best = i === 0 ? 3 : isBoundary(text, i) ? 2 : 1;
  while (best < 2 && (i = text.indexOf(w, i + 1)) >= 0) {
    if (isBoundary(text, i)) best = 2;
  }
  return best;
}

/** Scores text against words: every word must occur; prefixes and word starts score higher. -1: no match. */
export function score(text: string, words: readonly string[]): number {
  let total = 0;
  for (const w of words) {
    const s = wordScore(text, w);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

/** Like score, but every word must start a word of the text ("board" finds "Go to the board", not "Keyboard"). */
export function startScore(text: string, words: readonly string[]): number {
  let total = 0;
  for (const w of words) {
    const s = wordScore(text, w);
    if (s < 2) return -1;
    total += s;
  }
  return total;
}

/** Requires every word in name or context and at least one in the name; context-only hits belong to the repository. */
export function scoreNamed(name: string, context: string, words: readonly string[]): number {
  let total = 0;
  let own = 0;
  for (const w of words) {
    let s = wordScore(name, w);
    if (s >= 0) own++;
    else s = wordScore(context, w);
    if (s < 0) return -1;
    total += s;
  }
  return own ? total : -1;
}

export function repoScore(fullName: string, name: string, words: readonly string[]): number {
  const s = score(fullName, words);
  if (s < 0) return s;
  const q = words.join(' ');
  if (q === name || q === fullName) return 6 + s;
  return name.startsWith(q) || fullName.startsWith(q) ? 4 + s : s;
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

function* dataOf<T>(entities: Iterable<{data: T}>): Iterable<T> {
  for (const e of entities) yield e.data;
}

export function searchPool(pool: Pool, query: string, opts: SearchOptions = {}): SearchResults {
  const t = terms(query);
  const {ref} = t;
  const words = ref ? t.words.filter((w) => !w.includes('#')) : t.words;
  const number = ref ? ref.number : t.number;
  if (!t.words.length) return {repos: [], issues: []};
  const repoLimit = opts.repoLimit ?? 6;
  const issueLimit = opts.issueLimit ?? 12;

  const repoStore = pool.model('Repository');
  const repoText = (r: Repository) => lower(r, () => r.full_name);
  const repos: Ranked<Repository>[] = [];
  const seenRepos = new Set<number>();
  const considerRepo = (r: Repository) => {
    seenRepos.add(r.id);
    const s = ref ? score(repoText(r), [ref.owner ? `${ref.owner}/${ref.repo}` : ref.repo]) : repoScore(repoText(r), r.name.toLowerCase(), words);
    if (s >= 0) pushTop(repos, {item: r, score: s, updated: r.updated_at}, repoLimit);
  };
  for (const e of repoStore.all()) considerRepo(e.data);
  if (opts.extraRepos) for (const r of opts.extraRepos.values()) if (!seenRepos.has(r.id)) considerRepo(r);

  const repoOf = (id: number): Repository | undefined => repoStore.get(id)?.data ?? opts.extraRepos?.get(id);
  const refRepo = (repoId: number): boolean => {
    const r = repoOf(repoId);
    if (!r || !ref) return false;
    const full = r.full_name.toLowerCase();
    return ref.owner ? full === `${ref.owner}/${ref.repo}` : full.endsWith(`/${ref.repo}`);
  };
  const exact: Ranked<Issue>[] = [];
  const textWords = number === undefined ? words : words.filter((w) => !/^#?\d+$/.test(w));
  // Score repository names once per word, not once per issue.
  const inRepo = textWords.map((w) => {
    const m = new Map<number, number>();
    const add = (r: Repository) => {
      const t = wordScore(repoText(r), w);
      if (t >= 0) m.set(r.id, t);
    };
    for (const e of repoStore.all()) add(e.data);
    if (opts.extraRepos) for (const r of opts.extraRepos.values()) add(r);
    return m;
  });
  const match = (issue: Issue, needTitle: number): number => {
    const title = lower(issue, () => issue.title);
    let total = 0;
    let inTitle = 0;
    for (let k = 0; k < textWords.length; k++) {
      let t = wordScore(title, textWords[k] ?? '');
      if (t >= 0) {
        inTitle++;
      } else {
        t = inRepo[k]?.get(issue.repo_id) ?? -1;
        if (t < 0) return -1;
      }
      total += t;
    }
    return inTitle >= needTitle ? total : -1;
  };
  const issues: Ranked<Issue>[] = [];
  const prev = opts.narrow;
  // One-to-many-word queries cannot narrow: extra words may match the repository instead of the title.
  const before = prev ? terms(prev.query) : undefined;
  const narrowed = prev && before && number === undefined && before.number === undefined &&
    query.toLowerCase().startsWith(prev.query.toLowerCase()) && (before.words.length > 1 || words.length === 1);
  const candidates: Iterable<Issue> = narrowed ? prev.matched : dataOf(pool.model('Issue').all());
  let matched: Issue[] | undefined = [];
  for (const issue of candidates) {
    let s: number;
    if (number !== undefined && issue.number === number && (ref ? refRepo(issue.repo_id) : textWords.length === 0 && opts.contextRepo === issue.repo_id)) {
      pushTop(exact, {item: issue, score: 10, updated: issue.updated_at}, 4);
      continue;
    }
    if (ref && issue.number === number) continue;
    if (number !== undefined && issue.number === number) {
      const t = textWords.length ? match(issue, 0) : 0;
      if (t < 0) continue;
      s = 4 + t;
    } else {
      s = match(issue, 1);
      if (s < 0) continue;
      if (issue.state === 'open') s += 0.5;
    }
    // Issues without a known repository cannot be opened.
    if (!repoOf(issue.repo_id)) continue;
    if (matched) {
      if (matched.length < KEEP) matched.push(issue);
      else matched = undefined;
    }
    pushTop(issues, {item: issue, score: s, updated: issue.updated_at}, issueLimit);
  }
  return {
    repos: repos.map((r) => r.item),
    issues: issues.map((r) => ({issue: r.item, repo: repoOf(r.item.repo_id)})),
    top: {repos: repos[0]?.score ?? -1, issues: issues[0]?.score ?? -1},
    exact: exact.map((r) => ({issue: r.item, repo: repoOf(r.item.repo_id)})),
    matched,
  };
}
