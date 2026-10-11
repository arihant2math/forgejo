// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's activity, computed here (pure; pulse.test.ts): the Pulse of
// a period from the pool's issues, pull requests and releases (as the
// classic page counts them: models/activities/repo_activity.go), its commit
// counts and top committers from one cached year of history (B9
// /activity/{commit}), and the weekly series of the graphs.

import type {APICommitActivity, APIWeek} from '../../protocol/types.gen.ts';

/** The periods of the classic page, by their address segment (routers/livesync/spa.go activityPeriods). */
export const PERIODS = [
  {id: 'daily', label: '1 day'},
  {id: 'halfweekly', label: '3 days'},
  {id: 'weekly', label: '1 week'},
  {id: 'monthly', label: '1 month'},
  {id: 'quarterly', label: '3 months'},
  {id: 'semiyearly', label: '6 months'},
  {id: 'yearly', label: '1 year'},
] as const;

export type Period = typeof PERIODS[number]['id'];

/** The period an address names; anything else is a week (as the classic page). */
export function parsePeriod(s: string | undefined): Period {
  return PERIODS.find((p) => p.id === s)?.id ?? 'weekly';
}

export function periodLabel(p: Period): string {
  return PERIODS.find((x) => x.id === p)?.label ?? '1 week';
}

const HOUR = 3_600_000;

/** When a period that ends `now` starts (ms): hours for the short ones, calendar months for the others (classic). */
export function periodStart(p: Period, now: number): number {
  const months = (n: number) => {
    const d = new Date(now);
    d.setMonth(d.getMonth() - n);
    return d.getTime();
  };
  switch (p) {
    case 'daily': return now - 24 * HOUR;
    case 'halfweekly': return now - 72 * HOUR;
    case 'weekly': return now - 168 * HOUR;
    case 'monthly': return months(1);
    case 'quarterly': return months(3);
    case 'semiyearly': return months(6);
    case 'yearly': return months(12);
  }
}

/** What the Pulse reads of an issue or pull request (its pull request part, if any, merged in). */
export interface PulseIssue {
  id: number;
  is_pull: boolean;
  /** As shown here (the overlay's: a close made on this device counts). */
  state: string;
  poster_id: number;
  created_at: string;
  updated_at: string;
  closed_at?: string | undefined;
  merged?: boolean | undefined;
  merged_at?: string | undefined;
}

export interface PulseRelease {
  id: number;
  publisher_id: number;
  draft: boolean;
  is_tag: boolean;
  created_at: string;
}

/** A list of the Pulse with the number of distinct people behind it (posters, publishers). */
export interface PulseList<T> {
  items: T[];
  authors: number;
}

export interface Pulse<I extends PulseIssue, R extends PulseRelease> {
  /** Merged in the period, latest first. */
  merged: PulseList<I>;
  /** Opened in the period and still open ("proposed"), newest first. */
  opened: PulseList<I>;
  /** Issues closed in the period, latest first. */
  closed: PulseList<I>;
  /** Issues opened in the period (open or not), newest first. */
  created: PulseList<I>;
  /** Issues and pull requests opened before the period, still open, updated in it: most recently updated first. */
  unresolved: I[];
  /** Releases (not drafts, not bare tags) published in the period, newest first. */
  releases: PulseList<R>;
  /** Pull requests merged or opened (and open) in the period; issues opened or closed in it. */
  activePulls: number;
  activeIssues: number;
}

const ms = (s: string | undefined): number => (s ? Date.parse(s) : Number.NaN);

function list<T>(items: T[], at: (t: T) => number, who: (t: T) => number, newestFirst = true): PulseList<T> {
  items.sort((a, b) => (newestFirst ? at(b) - at(a) : at(a) - at(b)));
  return {items, authors: new Set(items.map(who)).size};
}

/**
 * The Pulse of [from, to) (ms) over a repository's issues, pull requests and releases, as the classic page
 * counts them (models/activities/repo_activity.go): merged pull requests by merge time; "proposed" ones opened in
 * the period and still open; issues closed in it, issues opened in it; unresolved conversations opened before
 * it, still open and updated in it; releases published in it.
 */
export function pulse<I extends PulseIssue, R extends PulseRelease>(issues: Iterable<I>, releases: Iterable<R>, from: number, to = Infinity): Pulse<I, R> {
  const within = (t: number) => t >= from && t < to;
  const merged: I[] = [];
  const opened: I[] = [];
  const closed: I[] = [];
  const created: I[] = [];
  const unresolved: I[] = [];
  const active = new Set<number>();
  for (const i of issues) {
    const createdAt = ms(i.created_at);
    const open = i.state === 'open';
    if (i.is_pull) {
      if (i.merged && within(ms(i.merged_at))) merged.push(i);
      if (open && within(createdAt)) opened.push(i);
    } else {
      const isNew = within(createdAt);
      const isClosed = !open && within(ms(i.closed_at));
      if (isNew) created.push(i);
      if (isClosed) closed.push(i);
      if (isNew || isClosed) active.add(i.id);
    }
    if (open && createdAt < from && within(ms(i.updated_at))) unresolved.push(i);
  }
  const published = [...releases].filter((r) => !r.draft && !r.is_tag && within(ms(r.created_at)));
  unresolved.sort((a, b) => ms(b.updated_at) - ms(a.updated_at));
  const poster = (i: I) => i.poster_id;
  return {
    merged: list(merged, (i) => ms(i.merged_at), poster),
    opened: list(opened, (i) => ms(i.created_at), poster),
    closed: list(closed, (i) => ms(i.closed_at), poster),
    created: list(created, (i) => ms(i.created_at), poster),
    unresolved,
    releases: list(published, (r) => ms(r.created_at), (r) => r.publisher_id),
    activePulls: merged.length + opened.length,
    activeIssues: active.size,
  };
}

/** The commits of a period (from the history of APICommitActivity). */
export interface CommitSummary {
  commits: number;
  additions: number;
  deletions: number;
  /** Every author with a commit in the period, most commits first (index into the history's authors). */
  authors: {author: number; commits: number}[];
  /**
   * The history does not reach back to the period's start (it holds a year, or was cut at its limit): the counts
   * are at least these.
   */
  partial: boolean;
}

/** The commits of [from, to) (ms) in a history (newest first: [time s, author, additions, deletions]). */
export function commitSummary(a: Pick<APICommitActivity, 'commits' | 'since' | 'truncated'>, from: number, to = Infinity): CommitSummary {
  let commits = 0;
  let additions = 0;
  let deletions = 0;
  const by = new Map<number, number>();
  for (const [t = 0, author = 0, add = 0, del = 0] of a.commits) {
    const at = t * 1000;
    if (at < from || at >= to) continue;
    commits++;
    additions += add;
    deletions += del;
    by.set(author, (by.get(author) ?? 0) + 1);
  }
  const oldest = a.commits.at(-1)?.[0];
  const partial = a.since * 1000 > from || (a.truncated && oldest !== undefined && oldest * 1000 > from);
  const authors = [...by].map(([author, n]) => ({author, commits: n})).sort((x, y) => y.commits - x.commits || x.author - y.author);
  return {commits, additions, deletions, authors, partial};
}


/** The start of the week (Sunday 00:00 UTC, as Forgejo's contributor statistics) a time is in (ms). */
export function weekOf(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay());
}

/**
 * A weekly series without gaps from `from` to `to` (week starts, ms; both included): weeks without a commit are
 * zeros. Defaults: the first and the last week of the series.
 */
export function fillWeeks(weeks: readonly APIWeek[], from?: number, to?: number): APIWeek[] {
  const a = from ?? weeks[0]?.week;
  const b = to ?? weeks.at(-1)?.week;
  if (a === undefined || b === undefined) return [];
  const end = weekOf(b);
  const by = new Map(weeks.map((w) => [weekOf(w.week), w]));
  const out: APIWeek[] = [];
  for (let w = weekOf(a); w <= end; w = addDays(w, 7)) out.push(by.get(w) ?? {week: w, commits: 0, additions: 0, deletions: 0});
  return out;
}

/** A UTC midnight `n` days later (a week is always 7 UTC days long). */
function addDays(t: number, n: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n);
}

/** The last `n` weeks up to the week of `now` (the recent commits graph: 52). */
export function lastWeeks(weeks: readonly APIWeek[], n: number, now: number): APIWeek[] {
  const end = weekOf(now);
  const start = addDays(end, -7 * (n - 1));
  return fillWeeks(weeks.filter((w) => w.week >= start && w.week <= end), start, end);
}

/**
 * A whole history's weeks without gaps, at least a year of them (ending at its last week): a young repository's
 * graph keeps the scale of an older one's instead of a few columns across the page.
 */
export function yearAtLeast(weeks: readonly APIWeek[]): APIWeek[] {
  const last = weeks.at(-1)?.week;
  const first = weeks[0]?.week;
  if (last === undefined || first === undefined) return [];
  return fillWeeks(weeks, Math.min(weekOf(first), addDays(weekOf(last), -7 * 51)), last);
}

/** A round upper bound for an axis (1, 2, 5 × 10^k) at or above `v`, at least 1. */
export function niceMax(v: number): number {
  if (!(v > 1)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
