// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's milestones pages, the pure part: the open / closed tabs,
// the orders (the classic page's `sort` values, plus "recently updated"),
// the search, overdue, the description's excerpt and the due date as the
// form edits it.

import type {MilestoneSort, MilestonesSearch} from '../../app/search.ts';
import type {Milestone} from '../../protocol/types.gen.ts';
import {milestoneProgress, type MilestoneCount, type Progress} from './counts.ts';

/** The orders' names (app/search.ts MILESTONE_SORTS). */
export const MILESTONE_SORT_NAMES: Record<MilestoneSort, string> = {
  closestduedate: 'Closest due date', furthestduedate: 'Furthest due date', recentupdate: 'Recently updated', leastcomplete: 'Least complete',
  mostcomplete: 'Most complete', mostissues: 'Most issues', leastissues: 'Fewest issues', name: 'Name',
};

const collator = new Intl.Collator(undefined, {sensitivity: 'base', numeric: true});
const time = (s: string | undefined) => (s ? Date.parse(s) : Number.NaN);

/** A milestone with its progress (counts.ts), as the list shows it. */
export interface MilestoneRow {
  milestone: Milestone;
  progress: Progress;
}

/** The rows of a repository's milestones with their progress. */
export function milestoneRows(milestones: Iterable<Milestone>, counts: ReadonlyMap<number, MilestoneCount>): MilestoneRow[] {
  return [...milestones].map((m) => ({milestone: m, progress: milestoneProgress(m, counts.get(m.id))}));
}

/** The rows of a tab that match the search (every word in the title or the description), in an order. */
export function listMilestones(rows: readonly MilestoneRow[], search: MilestonesSearch): MilestoneRow[] {
  const state = search.state ?? 'open';
  const words = (search.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter((r) => (r.milestone.state === 'closed' ? 'closed' : 'open') === state &&
    words.every((w) => `${r.milestone.title} ${r.milestone.description}`.toLowerCase().includes(w)));
  return sortMilestones(shown, search.sort ?? 'closestduedate');
}

/** Rows in an order; ties by title. Milestones without a due date come last in either date order. */
export function sortMilestones(rows: readonly MilestoneRow[], sort: MilestoneSort): MilestoneRow[] {
  const byTitle = (a: MilestoneRow, b: MilestoneRow) => collator.compare(a.milestone.title, b.milestone.title) || a.milestone.id - b.milestone.id;
  const byDue = (dir: 1 | -1) => (a: MilestoneRow, b: MilestoneRow) => {
    const x = time(a.milestone.due_on);
    const y = time(b.milestone.due_on);
    if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1;
    return (Number.isNaN(x) ? 0 : (x - y) * dir) || byTitle(a, b);
  };
  const by = (key: (r: MilestoneRow) => number, dir: 1 | -1) => (a: MilestoneRow, b: MilestoneRow) => (key(a) - key(b)) * dir || byTitle(a, b);
  const out = [...rows];
  switch (sort) {
    case 'closestduedate':
      return out.sort(byDue(1));
    case 'furthestduedate':
      return out.sort(byDue(-1));
    case 'recentupdate':
      return out.sort(by((r) => time(r.milestone.updated_at) || 0, -1));
    case 'leastcomplete':
      return out.sort(by((r) => r.progress.percent, 1));
    case 'mostcomplete':
      return out.sort(by((r) => r.progress.percent, -1));
    case 'mostissues':
      return out.sort(by((r) => r.progress.total, -1));
    case 'leastissues':
      return out.sort(by((r) => r.progress.total, 1));
    case 'name':
      return out.sort(byTitle);
  }
}

/** Whether an open milestone's due date has passed. */
export function overdue(m: Pick<Milestone, 'state' | 'due_on'>, now = Date.now()): boolean {
  const t = time(m.due_on);
  return m.state !== 'closed' && !Number.isNaN(t) && t < now;
}

/** The first words of a markdown description as plain text, for a list (at most `max` characters). */
export function excerpt(markdown: string, max = 160): string {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** A due date as the form's date field holds it ("2026-10-31"; its UTC date), "" for none. */
export function dateField(dueOn: string | undefined): string {
  const t = time(dueOn);
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
}

/**
 * The `due_on` API v1 takes for a date field's value: the end of that day (UTC), or — to clear it — Forgejo's "no
 * deadline", 9999-12-31 (API v1 ignores a missing or zero `due_on` on an edit; the sync shows that date as none).
 */
export function dueOnOf(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59Z` : '9999-12-31T12:00:00Z';
}

/** What a milestone's form holds. */
export interface MilestoneDraft {
  title: string;
  description: string;
  /** "YYYY-MM-DD", or "" for none. */
  due: string;
}

/** What is wrong with a draft (undefined: it can be saved). */
export function milestoneProblem(d: MilestoneDraft): string | undefined {
  if (!d.title.trim()) return 'A milestone needs a title.';
  if (d.title.trim().length > 255) return 'At most 255 characters.';
  if (d.due && !/^\d{4}-\d{2}-\d{2}$/.test(d.due)) return 'A date as YYYY-MM-DD.';
  return undefined;
}

/** The draft of an existing milestone (its form, filled). */
export function milestoneDraft(m: Milestone | undefined): MilestoneDraft {
  return m ? {title: m.title, description: m.description, due: dateField(m.due_on)} : {title: '', description: '', due: ''};
}
