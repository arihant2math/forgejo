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
  /** The best scores (repositories, issues), for ranking the palette's groups against each other; -1 when none. */
  top?: {repos: number; issues: number};
  /** Issues the query names exactly ("atlas#85", "acme/atlas#1", "#12" in the repository on screen): first. */
  exact?: {issue: Issue; repo: Repository | undefined}[];
  /** Every issue that matched (undefined when too many to keep): the candidates of a narrower query. */
  matched?: Issue[] | undefined;
}

/** A previous search whose matches a query that extends it can be narrowed from. */
export interface Narrowing {
  query: string;
  matched: readonly Issue[];
}

/** Matches kept for narrowing at most (a one-letter query matches nearly everything: scan again). */
const KEEP = 20_000;

export interface SearchOptions {
  repoLimit?: number;
  issueLimit?: number;
  /** Repositories not in the pool yet (Data.peek). */
  extraRepos?: ReadonlyMap<number, Repository>;
  /** The repository on screen: a bare "#12" names its issue exactly. */
  contextRepo?: number | undefined;
  /**
   * The previous keystroke's search: when this query extends it (more letters
   * or words, no issue number), only its matches can match (typing narrows;
   * a delta that arrives meanwhile shows at the next full scan).
   */
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

/** An issue reference: "repo#12", "owner/repo#12" (lower case). */
export interface IssueRef {
  owner?: string | undefined;
  repo: string;
  number: number;
}

/** The query's terms: lower-cased words; "#12" and "12" also look for issue number 12; "repo#12" is a reference. */
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
  // Not a letter or digit: space, "/", "-", "_", ".", "#", …
  return !((c >= 48 && c <= 57) || (c >= 97 && c <= 122) || c > 127);
}

/** One word in text: 3 at the start, 2 at a word start, 1 inside, -1 absent. */
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
  // A reference matches by its number in the repositories it names; its other words as usual.
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
    const s = score(repoText(r), ref ? [ref.owner ? `${ref.owner}/${ref.repo}` : ref.repo] : words);
    if (s >= 0) pushTop(repos, {item: r, score: s, updated: r.updated_at}, repoLimit);
  };
  for (const e of repoStore.all()) considerRepo(e.data);
  if (opts.extraRepos) for (const r of opts.extraRepos.values()) if (!seenRepos.has(r.id)) considerRepo(r);

  const repoOf = (id: number): Repository | undefined => repoStore.get(id)?.data ?? opts.extraRepos?.get(id);
  /** Whether an issue's repository is the one a reference names. */
  const refRepo = (repoId: number): boolean => {
    const r = repoOf(repoId);
    if (!r || !ref) return false;
    const full = r.full_name.toLowerCase();
    return ref.owner ? full === `${ref.owner}/${ref.repo}` : full.endsWith(`/${ref.repo}`);
  };
  const exact: Ranked<Issue>[] = [];
  // Words other than the number match the title or the repository's name.
  const textWords = number === undefined ? words : words.filter((w) => !/^#?\d+$/.test(w));
  // Per word, the repositories whose name has it (scored once, not per issue: no string is built per issue).
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
  /** Every word in the title or the repository's name, at least `needTitle` of them in the title; -1 otherwise. */
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
  // A query that extends the previous one matches a subset of its matches — except from one word
  // to several: one word must be in the title, while with several the rest may name the repository.
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
      // One word: the title. Several: the title has at least one, the rest may name the repository.
      s = match(issue, 1);
      if (s < 0) continue;
      if (issue.state === 'open') s += 0.5;
    }
    // An issue whose repository is not known here cannot be opened: no slot for it.
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
