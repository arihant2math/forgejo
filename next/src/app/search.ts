// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Use classic query names and values so shared URLs mean the same in both UIs; drop malformed values.

/** Keeps values as strings and takes the first repeated key.
 * TanStack's JSON decoding coerces numeric/boolean search text, and dropped raw keys survive route validation.
 */
export function parsePlainSearch(str: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(str.startsWith('?') ? str.slice(1) : str)) {
    if (!Object.hasOwn(out, k)) out[k] = v;
  }
  return out;
}

const MY_TYPES = ['your_repositories', 'assigned', 'created_by', 'mentioned', 'review_requested'] as const;
const STATES = ['open', 'closed', 'all'] as const;
const SORTS = ['newest', 'oldest', 'recentupdate', 'leastupdate', 'mostcomment', 'leastcomment', 'nearduedate', 'farduedate', 'priority'] as const;
const GROUPS = ['none', 'status', 'priority', 'assignee', 'milestone', 'repo'] as const;

export type MyListType = typeof MY_TYPES[number];
export type ListState = typeof STATES[number];
export type ListSort = typeof SORTS[number];
export type ListGroup = typeof GROUPS[number];

export interface ListSearch {
  state?: ListState;
  q?: string;
  /** Label ids, comma-separated; a negative id excludes the label. */
  labels?: string;
  milestone?: number;
  assignee?: number;
  poster?: number;
  sort?: ListSort;
  group?: ListGroup;
  /** Status/priority label values, rather than repository-specific ids, for cross-repository filters. */
  status?: string;
  priority?: string;
  /** Label name for cross-repository filtering. */
  label?: string;
  repo?: number;
}

export interface MyListSearch extends ListSearch {
  type?: MyListType;
}

export type IssueListSearch = ListSearch;

function oneOf<T extends string>(values: readonly T[], v: unknown): T | undefined {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? v as T : undefined;
}

function idParam(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d{1,15}$/.test(v) ? Number(v) : Number.NaN;
  return Number.isSafeInteger(n) && (n > 0 || n === -1) ? n : undefined;
}

function labelsParam(v: unknown): string | undefined {
  const raw = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  const ids = raw.split(',').map((x) => x.trim()).filter((x) => /^-?[1-9]\d{0,15}$/.test(x));
  return ids.length ? [...new Set(ids)].slice(0, 50).join(',') : undefined;
}

export function parseLabels(labels: string | undefined): number[] {
  return labels ? labels.split(',').map(Number).filter((n) => Number.isSafeInteger(n) && n !== 0) : [];
}

export function listSearch(s: Record<string, unknown>): ListSearch {
  const out: ListSearch = {};
  const state = oneOf(STATES, s.state);
  if (state) out.state = state;
  const q = typeof s.q === 'string' && s.q.trim() ? s.q.slice(0, 256) : undefined;
  if (q) out.q = q;
  const labels = labelsParam(s.labels);
  if (labels) out.labels = labels;
  for (const k of ['milestone', 'assignee', 'poster'] as const) {
    const id = idParam(s[k]);
    if (id !== undefined) out[k] = id;
  }
  const sort = oneOf(SORTS, s.sort);
  if (sort) out.sort = sort;
  const group = oneOf(GROUPS, s.group);
  if (group) out.group = group;
  for (const k of ['status', 'priority', 'label'] as const) {
    const v = s[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 64);
  }
  const repo = idParam(s.repo);
  if (repo !== undefined && repo > 0) out.repo = repo;
  return out;
}

export function myListSearch(s: Record<string, unknown>): MyListSearch {
  const type = oneOf(MY_TYPES, s.type);
  return {...(type ? {type} : {}), ...listSearch(s)};
}

export function issueListSearch(s: Record<string, unknown>): IssueListSearch {
  return listSearch(s);
}

/** Defaults to unread and pinned; unread excludes read pins, all includes read notifications. */
export interface InboxSearch {
  filter?: 'unread' | 'all';
  group?: 'repo';
  reason?: 'review-requested' | 'mentioned' | 'assigned' | 'participating';
  repo?: number;
  type?: 'issue' | 'pr';
  state?: 'open' | 'closed' | 'merged';
}

export function inboxSearch(s: Record<string, unknown>): InboxSearch {
  const filter = oneOf(['unread', 'all'] as const, s.filter);
  const out: InboxSearch = {...(filter ? {filter} : {}), ...(s.group === 'repo' ? {group: 'repo' as const} : {})};
  const reason = oneOf(['review-requested', 'mentioned', 'assigned', 'participating'] as const, s.reason);
  const type = oneOf(['issue', 'pr'] as const, s.type);
  const state = oneOf(['open', 'closed', 'merged'] as const, s.state);
  const repo = idParam(s.repo);
  if (reason) out.reason = reason;
  if (type) out.type = type;
  if (state) out.state = state;
  if (repo !== undefined && repo > 0) out.repo = repo;
  return out;
}

const PULL_TABS = ['files', 'commits', 'checks'] as const;

export interface PullSearch {
  tab?: typeof PULL_TABS[number];
}

export function pullSearch(s: Record<string, unknown>): PullSearch {
  return (PULL_TABS as readonly unknown[]).includes(s.tab) ? {tab: s.tab as typeof PULL_TABS[number]} : {};
}

export const LABEL_SORTS = ['alphabetically', 'reversealphabetically', 'mostissues', 'leastissues'] as const;
export type LabelSort = typeof LABEL_SORTS[number];

export interface LabelsSearch {
  q?: string;
  sort?: LabelSort;
}

export function labelsSearch(s: Record<string, unknown>): LabelsSearch {
  const sort = oneOf(LABEL_SORTS, s.sort);
  return {...(typeof s.q === 'string' && s.q.trim() ? {q: s.q.slice(0, 256)} : {}), ...(sort && sort !== 'alphabetically' ? {sort} : {})};
}

export const MILESTONE_SORTS = ['closestduedate', 'furthestduedate', 'recentupdate', 'leastcomplete', 'mostcomplete', 'mostissues', 'leastissues', 'name'] as const;
export type MilestoneSort = typeof MILESTONE_SORTS[number];

export interface MilestonesSearch {
  state?: 'closed';
  q?: string;
  sort?: MilestoneSort;
}

export function milestonesSearch(s: Record<string, unknown>): MilestonesSearch {
  const sort = oneOf(MILESTONE_SORTS, s.sort);
  return {
    ...(s.state === 'closed' ? {state: 'closed' as const} : {}),
    ...(typeof s.q === 'string' && s.q.trim() ? {q: s.q.slice(0, 256)} : {}),
    ...(sort && sort !== 'closestduedate' ? {sort} : {}),
  };
}

/** Page 1 uses the bare address. */
export interface PageSearch {
  page?: number;
}

export function pageSearch(s: Record<string, unknown>): PageSearch {
  const raw = typeof s.page === 'number' ? String(s.page) : s.page;
  return typeof raw === 'string' && /^[1-9]\d{0,5}$/.test(raw) && raw !== '1' ? {page: Number(raw)} : {};
}
