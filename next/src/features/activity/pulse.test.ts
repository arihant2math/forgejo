// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {commitSummary, fillWeeks, lastWeeks, niceMax, yearAtLeast, parsePeriod, periodStart, pulse, type PulseIssue, type PulseRelease, weekOf} from './pulse.ts';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

let nextId = 1;
function issue(p: Partial<PulseIssue> & {created: number}): PulseIssue {
  const {created, ...rest} = p;
  return {id: nextId++, is_pull: false, state: 'open', poster_id: 1, created_at: at(created), updated_at: at(created), ...rest};
}

test('periods: the classic addresses, a week otherwise; their start', () => {
  expect(parsePeriod('monthly')).toBe('monthly');
  expect(parsePeriod(undefined)).toBe('weekly');
  expect(parsePeriod('hourly')).toBe('weekly');
  expect(periodStart('daily', NOW)).toBe(NOW - DAY);
  expect(periodStart('halfweekly', NOW)).toBe(NOW - 3 * DAY);
  expect(periodStart('weekly', NOW)).toBe(NOW - 7 * DAY);
  // Calendar months, as the classic page (Go's AddDate).
  const month = new Date(NOW);
  month.setMonth(month.getMonth() - 1);
  expect(periodStart('monthly', NOW)).toBe(month.getTime());
  const year = new Date(NOW);
  year.setFullYear(year.getFullYear() - 1);
  expect(periodStart('yearly', NOW)).toBe(year.getTime());
});

test('the Pulse of a week counts as the classic page does', () => {
  const from = NOW - 7 * DAY;
  const issues = [
    // Issues: opened in the week (one closed again), closed in it (opened before), outside it.
    issue({created: 2, poster_id: 1}),
    issue({created: 3, poster_id: 2, state: 'closed', closed_at: at(1), updated_at: at(1)}),
    issue({created: 30, poster_id: 3, state: 'closed', closed_at: at(5), updated_at: at(5)}),
    issue({created: 30, poster_id: 3, state: 'closed', closed_at: at(20), updated_at: at(20)}),
    // Unresolved: opened before the week, open, updated in it (an issue and a pull request).
    issue({created: 40, updated_at: at(1)}),
    issue({created: 40, is_pull: true, updated_at: at(2)}),
    // Not unresolved: updated before the week, or closed.
    issue({created: 40, updated_at: at(10)}),
    // Pull requests: merged in the week (opened before), opened in it and open, opened in it and merged.
    issue({created: 20, is_pull: true, state: 'closed', merged: true, merged_at: at(4), closed_at: at(4), updated_at: at(4), poster_id: 5}),
    issue({created: 1, is_pull: true, poster_id: 6}),
    issue({created: 2, is_pull: true, state: 'closed', merged: true, merged_at: at(1), closed_at: at(1), updated_at: at(1), poster_id: 6}),
    // Closed without merging in the week: neither merged nor proposed.
    issue({created: 3, is_pull: true, state: 'closed', closed_at: at(1), updated_at: at(1)}),
    // Merged before the week.
    issue({created: 30, is_pull: true, state: 'closed', merged: true, merged_at: at(9), closed_at: at(9), updated_at: at(9)}),
  ];
  const releases: PulseRelease[] = [
    {id: 1, publisher_id: 1, draft: false, is_tag: false, created_at: at(2)},
    {id: 2, publisher_id: 1, draft: false, is_tag: false, created_at: at(6)},
    {id: 3, publisher_id: 1, draft: true, is_tag: false, created_at: at(1)},
    {id: 4, publisher_id: 1, draft: false, is_tag: true, created_at: at(1)},
    {id: 5, publisher_id: 1, draft: false, is_tag: false, created_at: at(8)},
  ];
  const p = pulse(issues, releases, from, NOW);
  const ids = (xs: PulseIssue[]) => xs.map((x) => x.id);
  const [i1, i2, i3, , i5, i6, , p8, p9, p10] = issues.map((x) => x.id);
  expect(ids(p.created.items)).toEqual([i1, i2]);
  expect(p.created.authors).toBe(2);
  expect(ids(p.closed.items)).toEqual([i2, i3]); // latest first
  expect(p.closed.authors).toBe(2);
  expect(p.activeIssues).toBe(3);
  expect(ids(p.merged.items)).toEqual([p10, p8]);
  expect(p.merged.authors).toBe(2);
  expect(ids(p.opened.items)).toEqual([p9]);
  expect(p.activePulls).toBe(3);
  expect(ids(p.unresolved)).toEqual([i5, i6]);
  expect(p.releases.items.map((r) => r.id)).toEqual([1, 2]);
  expect(p.releases.authors).toBe(1);
});

test('another period over the same rows: one day', () => {
  const issues = [issue({created: 0.5}), issue({created: 2})];
  const p = pulse(issues, [], NOW - DAY, NOW);
  expect(p.created.items).toHaveLength(1);
  expect(p.activeIssues).toBe(1);
  // Nothing in the period: empty lists, no authors.
  const none = pulse([], [], NOW - DAY, NOW);
  expect(none.merged).toEqual({items: [], authors: 0});
  expect(none.activePulls).toBe(0);
});

test('commit counts and top committers of a period, from one year of history', () => {
  const s = (daysAgo: number) => Math.floor((NOW - daysAgo * DAY) / 1000);
  const history = {
    since: s(366),
    truncated: false,
    commits: [[s(0.5), 0, 10, 1], [s(1.5), 1, 5, 5], [s(2), 0, 1, 0], [s(3), 2, 0, 3], [s(10), 1, 100, 100]],
  };
  const day = commitSummary(history, NOW - DAY, NOW);
  expect(day).toEqual({commits: 1, additions: 10, deletions: 1, authors: [{author: 0, commits: 1}], partial: false});
  const week = commitSummary(history, NOW - 7 * DAY, NOW);
  expect(week.commits).toBe(4);
  expect(week.additions).toBe(16);
  expect(week.deletions).toBe(9);
  expect(week.authors).toEqual([{author: 0, commits: 2}, {author: 1, commits: 1}, {author: 2, commits: 1}]);
  // Beyond the history's year: at least these.
  expect(commitSummary(history, NOW - 400 * DAY, NOW).partial).toBe(true);
  // Cut at its limit before the period's start.
  expect(commitSummary({...history, truncated: true}, NOW - 30 * DAY, NOW).partial).toBe(true);
  expect(commitSummary({...history, truncated: true}, NOW - 7 * DAY, NOW).partial).toBe(false);
});

test('weeks: Sundays (UTC), gaps filled, the last n', () => {
  const sun = Date.UTC(2026, 9, 4);
  expect(weekOf(Date.UTC(2026, 9, 10, 23))).toBe(sun);
  expect(weekOf(sun)).toBe(sun);
  const w = (t: number, commits: number) => ({week: t, commits, additions: commits, deletions: 0});
  const prev = Date.UTC(2026, 8, 20);
  expect(fillWeeks([w(prev, 2), w(sun, 1)]).map((x) => [x.week, x.commits])).toEqual([
    [prev, 2], [Date.UTC(2026, 8, 27), 0], [sun, 1],
  ]);
  expect(fillWeeks([])).toEqual([]);
  const last = lastWeeks([w(prev, 2), w(Date.UTC(2020, 0, 5), 9)], 4, NOW);
  // NOW is a Sunday: its own week is the last.
  expect(last.map((x) => x.week)).toEqual([prev, Date.UTC(2026, 8, 27), sun, Date.UTC(2026, 9, 11)]);
  expect(last.map((x) => x.commits)).toEqual([2, 0, 0, 0]);
});

test('a whole history spans a year at least', () => {
  const w = (t: number) => ({week: t, commits: 1, additions: 0, deletions: 0});
  const young = yearAtLeast([w(Date.UTC(2026, 9, 4))]);
  expect(young).toHaveLength(52);
  expect(young.at(-1)?.commits).toBe(1);
  expect(young[0]?.commits).toBe(0);
  const old = yearAtLeast([w(Date.UTC(2020, 0, 5)), w(Date.UTC(2026, 9, 4))]);
  expect(old[0]?.week).toBe(Date.UTC(2020, 0, 5));
  expect(old.length).toBeGreaterThan(52 * 6);
  expect(yearAtLeast([])).toEqual([]);
});

test('axis bounds', () => {
  expect(niceMax(0)).toBe(1);
  expect(niceMax(1)).toBe(1);
  expect(niceMax(3)).toBe(5);
  expect(niceMax(17)).toBe(20);
  expect(niceMax(100)).toBe(100);
  expect(niceMax(101)).toBe(200);
});
