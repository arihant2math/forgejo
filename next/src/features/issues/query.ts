// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Filtering, sorting and grouping a list of issues (pure; computed locally
// from the pool in one pass, PLAN §2 goal 1: ≤ 1 frame). The caller hands in
// the candidates and a QueryContext that answers per-issue facts as the user
// sees them (with the overlay); list.ts wires it to the pool.
//
// Filter and sort names follow the classic UI's query strings (state,
// labels, milestone, assignee, poster, sort, q) so a URL means the same in
// both UIs; `group` is new.

import type {Issue, Label, Milestone, Repository} from '../../protocol/types.gen.ts';
import {kindRank, labelKind, scopedValue, type ScopeKind} from './labels.ts';

export const SORTS = ['newest', 'oldest', 'recentupdate', 'leastupdate', 'mostcomment', 'leastcomment', 'nearduedate', 'farduedate', 'priority'] as const;
export const GROUPS = ['none', 'status', 'priority', 'assignee', 'milestone', 'repo'] as const;
export type Sort = typeof SORTS[number];
export type Group = typeof GROUPS[number];

export interface Filter {
  state: 'open' | 'closed' | 'all';
  /** Every label must be on the issue; a negative id must not be. */
  labels: readonly number[];
  /** A user id; -1: nobody assigned. */
  assignee?: number | undefined;
  poster?: number | undefined;
  /** A milestone id; -1: no milestone. */
  milestone?: number | undefined;
  /** Words that must all be in the title, or "#12" / "12" for a number. */
  q?: string | undefined;
  /** A status and a priority by value (their labels' value, compared without case), in any repository. */
  status?: string | undefined;
  priority?: string | undefined;
  /** A label by name (compared without case), in any repository. */
  label?: string | undefined;
  /** One repository. */
  repo?: number | undefined;
}

export interface Query {
  filter: Filter;
  sort: Sort;
  group: Group;
}

export interface QueryContext {
  state(i: Issue): string;
  labels(i: Issue): readonly number[];
  assignees(i: Issue): readonly number[];
  milestone(i: Issue): number;
  label(id: number): Label | undefined;
  milestoneOf(id: number): Milestone | undefined;
  userName(id: number): string | undefined;
  repo(id: number): Repository | undefined;
  /**
   * The issue's place among its repository's pinned issues (1, 2, …; 0: not pinned). Given for a repository's
   * list: pinned issues come first in their group, in their pinned order (as the classic list shows them).
   */
  pin?: ((i: Issue) => number) | undefined;
}

export type Row =
  | {type: 'group'; key: string; label: string; count: number; kind: Group; value: number}
  | {type: 'issue'; id: number};

export interface QueryResult {
  rows: Row[];
  /** The issues in display order. */
  ids: number[];
}

interface Item {
  issue: Issue;
  /** Pinned order (0: not pinned). */
  pin: number;
  sortKey: number;
  group: GroupKey | undefined;
  /** The group's place among the run's groups (set before sorting). */
  order: number;
}

interface GroupKey {
  key: string;
  label: string;
  /** Order of the group. */
  rank: number;
  /** A tiebreak within equal ranks (names). */
  name: string;
  /** The entity the group stands for (label id, user id, milestone id, repository id; 0 for none). */
  value: number;
}

const time = (s: string | undefined) => (s ? Date.parse(s) : Number.NaN);

/** Parsed timestamps per issue version (an Issue object is immutable: a delta replaces it). */
const times = new WeakMap<Issue, {created: number; updated: number; due: number}>();
function timesOf(issue: Issue): {created: number; updated: number; due: number} {
  let t = times.get(issue);
  if (!t) times.set(issue, t = {created: time(issue.created_at), updated: time(issue.updated_at), due: time(issue.due_date)});
  return t;
}

const collator = new Intl.Collator();

/** A label's kind and rank, computed once per label and run. */
type LabelInfo = {label: Label; kind: ScopeKind | undefined; rank: number} | null;

/** Per-run caches: label facts and group keys are shared by every issue that has them. */
interface Run {
  ctx: QueryContext;
  labels: Map<number, LabelInfo>;
  /** The run's groups by the id of what they stand for (a run groups by one thing). */
  groups: Map<number, GroupKey>;
  /** Users' display names. */
  names: Map<number, string>;
}

/** Lower-cased words of a search, and the issue number it names (if any). */
export function parseSearch(q: string | undefined): {words: string[]; number: number | undefined} {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const num = words.length === 1 ? /^#?(\d{1,15})$/.exec(words[0] ?? '') : null;
  return {words, number: num ? Number(num[1]) : undefined};
}

/** Runs a query over the candidates. */
export function runQuery(candidates: Iterable<Issue>, query: Query, ctx: QueryContext): QueryResult {
  const {filter, sort, group} = query;
  const search = parseSearch(filter.q);
  const labelName = filter.label?.toLowerCase();
  const must = filter.labels.filter((l) => l > 0);
  const mustNot = filter.labels.filter((l) => l < 0).map((l) => -l);
  const items: Item[] = [];
  const run: Run = {ctx, labels: new Map(), groups: new Map(), names: new Map()};
  for (const issue of candidates) {
    const state = ctx.state(issue);
    if (filter.state !== 'all' && state !== filter.state) continue;
    if (filter.poster !== undefined && issue.poster_id !== filter.poster) continue;
    if (filter.repo !== undefined && issue.repo_id !== filter.repo) continue;
    if (labelName !== undefined && !ctx.labels(issue).some((id) => ctx.label(id)?.name.toLowerCase() === labelName)) continue;
    if (filter.milestone !== undefined) {
      const m = ctx.milestone(issue);
      if (filter.milestone === -1 ? m !== 0 : m !== filter.milestone) continue;
    }
    if (must.length || mustNot.length) {
      const ls = ctx.labels(issue);
      if (!must.every((l) => ls.includes(l)) || mustNot.some((l) => ls.includes(l))) continue;
    }
    if (filter.assignee !== undefined) {
      const as = ctx.assignees(issue);
      if (filter.assignee === -1 ? as.length > 0 : !as.includes(filter.assignee)) continue;
    }
    if (search.words.length && !matches(issue, search)) continue;
    if (filter.status !== undefined && !hasValue(issue, 'status', filter.status, run)) continue;
    if (filter.priority !== undefined && !hasValue(issue, 'priority', filter.priority, run)) continue;
    items.push({issue, pin: ctx.pin?.(issue) ?? 0, sortKey: sortKey(issue, sort, run), group: group === 'none' ? undefined : groupOf(issue, group, state, run), order: 0});
  }
  // The groups are ordered once (a handful of them), then the sort compares numbers only.
  if (group !== 'none') {
    const used = new Set<GroupKey>();
    for (const it of items) if (it.group) used.add(it.group);
    const keys = [...used];
    keys.sort((a, b) => a.rank - b.rank || collator.compare(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const order = new Map(keys.map((g, n) => [g, n]));
    for (const it of items) it.order = it.group ? order.get(it.group) ?? 0 : 0;
  }
  const desc = sort === 'newest' || sort === 'recentupdate' || sort === 'mostcomment' || sort === 'farduedate';
  items.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    // Pinned first (by their pinned order), then the sort.
    if ((a.pin > 0) !== (b.pin > 0)) return a.pin > 0 ? -1 : 1;
    if (a.pin !== b.pin) return a.pin - b.pin;
    const x = a.sortKey;
    const y = b.sortKey;
    // Missing values (no due date) go last either way.
    if (Number.isNaN(x) !== Number.isNaN(y)) return Number.isNaN(x) ? 1 : -1;
    if (x !== y && !Number.isNaN(x)) return desc ? y - x : x - y;
    return b.issue.id - a.issue.id;
  });
  const rows: Row[] = [];
  const ids: number[] = [];
  let current: GroupKey | undefined;
  let header: Extract<Row, {type: 'group'}> | undefined;
  for (const it of items) {
    if (it.group && it.group.key !== current?.key) {
      current = it.group;
      header = {type: 'group', key: it.group.key, label: it.group.label, count: 0, kind: group, value: it.group.value};
      rows.push(header);
    }
    if (header) header.count++;
    rows.push({type: 'issue', id: it.issue.id});
    ids.push(it.issue.id);
  }
  return {rows, ids};
}

/** Whether the issue's status (priority) label has this value. */
function hasValue(issue: Issue, kind: ScopeKind, value: string, run: Run): boolean {
  const k = runKindLabel(issue, kind, run);
  return k !== undefined && scopedValue(k.label.name).toLowerCase() === value.toLowerCase();
}

function matches(issue: Issue, s: {words: string[]; number: number | undefined}): boolean {
  if (s.number !== undefined && issue.number === s.number) return true;
  const title = issue.title.toLowerCase();
  return s.words.every((w) => title.includes(w.replace(/^#/, '')) || `#${String(issue.number)}` === w || nearWord(title, w));
}

/**
 * A typo (the ⌘K palette forgives them, so the lists do too): a word of 4 letters or more that is one edit — a
 * letter missing, extra, wrong or two swapped — from the start of a word of the title ("vectr" finds "vector").
 */
export function nearWord(title: string, w: string): boolean {
  if (w.length < 4) return false;
  for (const t of title.split(/[^\p{L}\p{N}]+/u)) {
    if (t.length < w.length - 1) continue;
    // The word as typed against the title word's start of the same length, one longer and one shorter.
    for (const n of [w.length, w.length + 1, w.length - 1]) {
      if (n <= t.length && oneEdit(w, t.slice(0, n))) return true;
    }
  }
  return false;
}

/** Whether a and b are at most one edit apart (Damerau: a swap of neighbours counts as one). */
function oneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function sortKey(issue: Issue, sort: Sort, run: Run): number {
  switch (sort) {
    case 'newest':
    case 'oldest':
      return timesOf(issue).created;
    case 'recentupdate':
    case 'leastupdate':
      return timesOf(issue).updated;
    case 'mostcomment':
    case 'leastcomment':
      return issue.comments;
    case 'nearduedate':
    case 'farduedate':
      return timesOf(issue).due;
    case 'priority':
      return runKindLabel(issue, 'priority', run)?.rank ?? 9;
  }
}

function runKindLabel(issue: Issue, kind: ScopeKind, run: Run): {label: Label; rank: number} | undefined {
  for (const id of run.ctx.labels(issue)) {
    let info = run.labels.get(id);
    if (info === undefined) {
      const l = run.ctx.label(id);
      const k = l ? labelKind(l) : undefined;
      info = l ? {label: l, kind: k, rank: k ? kindRank(k, l.name) : 0} : null;
      run.labels.set(id, info);
    }
    if (info?.kind === kind) return info;
  }
  return undefined;
}

/** The run's shared group for the entity `id` (made once). */
function interned(run: Run, id: number, make: (id: number) => GroupKey): GroupKey {
  let g = run.groups.get(id);
  if (!g) run.groups.set(id, g = make(id));
  return g;
}

const labelGroup = (k: {label: Label; rank: number}): GroupKey =>
  ({key: `l${String(k.label.id)}`, label: scopedValue(k.label.name), rank: k.rank, name: k.label.name, value: k.label.id});

function userName(run: Run, id: number): string {
  let n = run.names.get(id);
  if (n === undefined) run.names.set(id, n = run.ctx.userName(id) ?? `#${String(id)}`);
  return n;
}

/** The issue's label of a kind (status, priority) with its rank. */
export function kindLabel(issue: Issue, kind: ScopeKind, ctx: Pick<QueryContext, 'labels' | 'label'>): {label: Label; rank: number} | undefined {
  for (const id of ctx.labels(issue)) {
    const l = ctx.label(id);
    if (l && labelKind(l) === kind) return {label: l, rank: kindRank(kind, l.name)};
  }
  return undefined;
}

// Groups that stand for nothing (shared by every run).
const OPEN: GroupKey = {key: 'open', label: 'Open', rank: 1.5, name: '', value: 0};
const CLOSED: GroupKey = {key: 'closed', label: 'Closed', rank: 4.5, name: '', value: 0};
const NO_PRIORITY: GroupKey = {key: 'none', label: 'No priority', rank: 9, name: '', value: 0};
const UNASSIGNED: GroupKey = {key: 'none', label: 'Unassigned', rank: 1, name: '', value: 0};
const NO_MILESTONE: GroupKey = {key: 'none', label: 'No milestone', rank: Number.MAX_SAFE_INTEGER, name: '', value: 0};
const NONE: GroupKey = {key: '', label: '', rank: 0, name: '', value: 0};
/** Milestone group ranks: a tier (open/closed, dated/undated) apart, beyond any due date (ms). */
const MILESTONE_TIER = 1e15;

function groupOf(issue: Issue, group: Group, state: string, run: Run): GroupKey {
  const {ctx} = run;
  switch (group) {
    case 'status': {
      const k = runKindLabel(issue, 'status', run);
      if (k) return interned(run, k.label.id, () => labelGroup(k));
      // No status label: Forgejo's own state places it (before "in progress", or with "done").
      return state === 'closed' ? CLOSED : OPEN;
    }
    case 'priority': {
      const k = runKindLabel(issue, 'priority', run);
      return k ?
        interned(run, k.label.id, () => labelGroup(k)) :
        NO_PRIORITY;
    }
    case 'assignee': {
      // The first assignee by name.
      let best = 0;
      for (const id of ctx.assignees(issue)) {
        if (!best || collator.compare(userName(run, id), userName(run, best)) < 0) best = id;
      }
      if (!best) return UNASSIGNED;
      return interned(run, best, (id) => {
        const name = userName(run, id);
        return {key: `u${String(id)}`, label: name, rank: 0, name: name.toLowerCase(), value: id};
      });
    }
    case 'milestone': {
      const id = ctx.milestone(issue);
      const m = id ? ctx.milestoneOf(id) : undefined;
      if (!m) return NO_MILESTONE;
      return interned(run, m.id, () => {
        // Open milestones first, those with a due date soonest first (the current cycle on top, PLAN §7.3), then the
        // open ones without a date, then the closed ones (QA verify3: a closed "Cycle 13" came before "Cycle 14").
        const due = time(m.due_on);
        const tier = (m.state === 'closed' ? 2 : 0) + (Number.isNaN(due) ? 1 : 0);
        return {key: `m${String(m.id)}`, label: m.title, rank: tier * MILESTONE_TIER + (Number.isNaN(due) ? 0 : due), name: m.title.toLowerCase(), value: m.id};
      });
    }
    case 'repo': {
      return interned(run, issue.repo_id, () => {
        const name = ctx.repo(issue.repo_id)?.full_name ?? `#${String(issue.repo_id)}`;
        return {key: `r${String(issue.repo_id)}`, label: name, rank: 0, name: name.toLowerCase(), value: issue.repo_id};
      });
    }
    case 'none':
      return NONE;
  }
}
