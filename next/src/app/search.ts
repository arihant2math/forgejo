// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Typed search params of the list routes. Names and values follow the
// classic UI's query strings, so a URL means the same in both UIs
// (`labels=1,-2` every label / not that one, `milestone`, `assignee`,
// `poster` an id with 0 = any and -1 = none, `sort`); `group` is new. Unknown
// or malformed values are dropped (the route then shows its default).

const MY_TYPES = ['your_repositories', 'assigned', 'created_by', 'mentioned', 'review_requested'] as const;
const STATES = ['open', 'closed', 'all'] as const;
const SORTS = ['newest', 'oldest', 'recentupdate', 'leastupdate', 'mostcomment', 'leastcomment', 'nearduedate', 'farduedate', 'priority'] as const;
const GROUPS = ['none', 'status', 'priority', 'assignee', 'milestone', 'repo'] as const;

export type MyListType = typeof MY_TYPES[number];
export type ListState = typeof STATES[number];
export type ListSort = typeof SORTS[number];
export type ListGroup = typeof GROUPS[number];

/** What every issue list understands. */
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
}

/** /issues, /pulls (the viewer's work across repositories). */
export interface MyListSearch extends ListSearch {
  type?: MyListType;
}

/** /{owner}/{repo}/issues, /pulls. */
export type IssueListSearch = ListSearch;

function oneOf<T extends string>(values: readonly T[], v: unknown): T | undefined {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? v as T : undefined;
}

/** An id filter: a positive id, or -1 (none); 0 and junk mean "any" (dropped). */
function idParam(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d{1,15}$/.test(v) ? Number(v) : Number.NaN;
  return Number.isSafeInteger(n) && (n > 0 || n === -1) ? n : undefined;
}

/** A labels filter, normalised ("1,-2"); undefined when empty or malformed. */
function labelsParam(v: unknown): string | undefined {
  const raw = typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '';
  const ids = raw.split(',').map((x) => x.trim()).filter((x) => /^-?[1-9]\d{0,15}$/.test(x));
  return ids.length ? [...new Set(ids)].slice(0, 50).join(',') : undefined;
}

/** Parses a labels param into ids (negative: excluded). */
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
  return out;
}

export function myListSearch(s: Record<string, unknown>): MyListSearch {
  const type = oneOf(MY_TYPES, s.type);
  return {...(type ? {type} : {}), ...listSearch(s)};
}

export function issueListSearch(s: Record<string, unknown>): IssueListSearch {
  return listSearch(s);
}
