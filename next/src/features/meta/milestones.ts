// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import type {MilestoneSort, MilestonesSearch} from '../../app/search.ts';
import type {Milestone} from '../../protocol/types.gen.ts';
import {milestoneProgress, type MilestoneCount, type Progress} from './counts.ts';

export const MILESTONE_SORT_NAMES: Record<MilestoneSort, string> = {
  closestduedate: 'Closest due date', furthestduedate: 'Furthest due date', recentupdate: 'Recently updated', leastcomplete: 'Least complete',
  mostcomplete: 'Most complete', mostissues: 'Most issues', leastissues: 'Fewest issues', name: 'Name',
};

const collator = new Intl.Collator(undefined, {sensitivity: 'base', numeric: true});
const time = (s: string | undefined) => (s ? Date.parse(s) : Number.NaN);

export interface MilestoneRow {
  milestone: Milestone;
  progress: Progress;
}

export function milestoneRows(milestones: Iterable<Milestone>, counts: ReadonlyMap<number, MilestoneCount>): MilestoneRow[] {
  return [...milestones].map((m) => ({milestone: m, progress: milestoneProgress(m, counts.get(m.id))}));
}

export function listMilestones(rows: readonly MilestoneRow[], search: MilestonesSearch): MilestoneRow[] {
  const state = search.state ?? 'open';
  const words = (search.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter((r) => (r.milestone.state === 'closed' ? 'closed' : 'open') === state &&
    words.every((w) => `${r.milestone.title} ${r.milestone.description}`.toLowerCase().includes(w)));
  return sortMilestones(shown, search.sort ?? 'closestduedate');
}

/** Ties sort by title; missing due dates sort last in either date order. */
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

export function overdue(m: Pick<Milestone, 'state' | 'due_on'>, now = Date.now()): boolean {
  const t = time(m.due_on);
  return m.state !== 'closed' && !Number.isNaN(t) && t < now;
}

/** Plain-text Markdown excerpt, at most max characters. */
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

/** UTC date as YYYY-MM-DD, or empty for no deadline. */
export function dateField(dueOn: string | undefined): string {
  const t = time(dueOn);
  return Number.isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
}

/** End of day UTC; clear with Forgejo's 9999-12-31 sentinel because API v1 ignores missing/zero dates. */
export function dueOnOf(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59Z` : '9999-12-31T12:00:00Z';
}

export interface MilestoneDraft {
  title: string;
  description: string;
  /** "YYYY-MM-DD", or "" for none. */
  due: string;
}

export interface MilestoneProblems {
  title?: string;
  due?: string;
}

/** Restrict native date fields to four-digit years. */
export const MAX_DUE = '9999-12-31';

export function validDate(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === date;
}

/** What is wrong with each field of a draft (an empty object: it can be saved). */
export function milestoneProblems(d: MilestoneDraft): MilestoneProblems {
  const out: MilestoneProblems = {};
  if (!d.title.trim()) out.title = 'A milestone needs a title.';
  else if (d.title.trim().length > 255) out.title = 'At most 255 characters.';
  if (d.due && !validDate(d.due)) out.due = /^\d{5,}-/.test(d.due) ? 'The year needs four digits.' : 'Not a valid date.';
  return out;
}

export function milestoneDraft(m: Milestone | undefined): MilestoneDraft {
  return m ? {title: m.title, description: m.description, due: dateField(m.due_on)} : {title: '', description: '', due: ''};
}
