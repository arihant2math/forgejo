// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import type {Issue, Label, Milestone} from '../../protocol/types.gen.ts';
import {issue, T} from '../../test/fakeSession.ts';
import {exclusiveScope, labelKind, priorityRank, scopeKind, scopedValue, statusRank} from './labels.ts';
import {type Filter, type Query, type QueryContext, runQuery} from './query.ts';

const label = (id: number, name: string, exclusive = true): Label => ({
  id, repo_id: 1, org_id: 0, name, exclusive, description: '', color: '#888888', num_issues: 0, num_closed_issues: 0, created_at: T,
});

const LABELS = [
  label(1, 'status/Backlog'), label(2, 'status/In Progress'), label(3, 'status/Done'),
  label(4, 'priority/Urgent'), label(5, 'priority/Low'), label(6, 'bug', false), label(7, 'kind/status', false),
];
const MILESTONES: Milestone[] = [
  {id: 1, repo_id: 1, title: 'Later', description: '', state: 'open', open_issues: 0, closed_issues: 0, created_at: T, updated_at: T},
  {id: 2, repo_id: 1, title: 'Cycle 42', description: '', state: 'open', open_issues: 0, closed_issues: 0, due_on: '2026-10-20T00:00:00Z', created_at: T, updated_at: T},
];

function ctx(facts: Record<number, {labels?: number[]; assignees?: number[]; state?: string}>): QueryContext {
  return {
    state: (i) => facts[i.id]?.state ?? i.state,
    labels: (i) => facts[i.id]?.labels ?? [],
    assignees: (i) => facts[i.id]?.assignees ?? [],
    milestone: (i) => i.milestone_id,
    label: (id) => LABELS.find((l) => l.id === id),
    milestoneOf: (id) => MILESTONES.find((m) => m.id === id),
    userName: (id) => ({1: 'dev', 2: 'alice'})[id],
    repo: () => undefined,
  };
}

const q = (filter: Partial<Filter> = {}, rest: Partial<Omit<Query, 'filter'>> = {}): Query => ({filter: {state: 'open', labels: [], ...filter}, sort: 'newest', group: 'none', ...rest});
const ids = (r: ReturnType<typeof runQuery>) => r.ids;

const ISSUES: Issue[] = [
  issue(1, 1, 1, 'Crash when saving', {created_at: '2026-01-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z', comments: 3, milestone_id: 2}),
  issue(2, 1, 2, 'Dark mode', {created_at: '2026-02-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z', poster_id: 2, due_date: '2026-11-01T00:00:00Z'}),
  issue(3, 1, 3, 'Old bug', {state: 'closed', created_at: '2026-03-01T00:00:00Z', updated_at: '2026-04-01T00:00:00Z', comments: 9}),
  issue(4, 1, 12, 'Keyboard shortcuts', {created_at: '2026-04-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', milestone_id: 1, due_date: '2026-10-15T00:00:00Z'}),
];
const FACTS = {
  1: {labels: [2, 4, 6], assignees: [1]},
  2: {labels: [1, 5], assignees: [2, 1]},
  3: {labels: [3, 6]},
  4: {labels: [6]},
};

describe('labels', () => {
  test('exclusive scope as Forgejo computes it; status/priority kinds and ranks', () => {
    expect(exclusiveScope(label(1, 'status/In Progress'))).toBe('status');
    expect(exclusiveScope(label(1, 'a/b/c'))).toBe('a/b');
    expect(exclusiveScope(label(1, 'status/x', false))).toBe('');
    expect(exclusiveScope(label(1, '/x'))).toBe('');
    expect(exclusiveScope(label(1, 'x/'))).toBe('');
    expect(scopeKind('Status')).toBe('status');
    expect(scopeKind('team/priority')).toBe('priority');
    expect(scopeKind('kind')).toBeUndefined();
    expect(labelKind(label(7, 'kind/status', false))).toBeUndefined();
    expect(scopedValue('status/In Progress')).toBe('In Progress');
    expect(['Done', 'Backlog', 'In Review', 'Todo', 'Weird', 'In Progress', "Won't fix"].sort((a, b) => statusRank(a) - statusRank(b)))
      .toEqual(['Backlog', 'Todo', 'In Progress', 'Weird', 'In Review', 'Done', "Won't fix"]);
    expect(['Low', 'P0', 'Urgent', 'none', 'High', 'Medium'].map(priorityRank)).toEqual([3, 0, 0, 4, 1, 2]);
  });
});

describe('runQuery', () => {
  test('state, labels (all of / not), assignee, poster, milestone, search', () => {
    const c = ctx(FACTS);
    expect(ids(runQuery(ISSUES, q(), c))).toEqual([4, 2, 1]);
    expect(ids(runQuery(ISSUES, q({state: 'closed'}), c))).toEqual([3]);
    expect(ids(runQuery(ISSUES, q({state: 'all'}), c))).toEqual([4, 3, 2, 1]);
    expect(ids(runQuery(ISSUES, q({labels: [6]}), c))).toEqual([4, 1]);
    expect(ids(runQuery(ISSUES, q({labels: [6, 4]}), c))).toEqual([1]);
    expect(ids(runQuery(ISSUES, q({labels: [-6]}), c))).toEqual([2]);
    expect(ids(runQuery(ISSUES, q({assignee: 2}), c))).toEqual([2]);
    expect(ids(runQuery(ISSUES, q({assignee: -1}), c))).toEqual([4]);
    expect(ids(runQuery(ISSUES, q({poster: 2}), c))).toEqual([2]);
    expect(ids(runQuery(ISSUES, q({milestone: 2}), c))).toEqual([1]);
    expect(ids(runQuery(ISSUES, q({milestone: -1}), c))).toEqual([2]);
    expect(ids(runQuery(ISSUES, q({q: 'CRASH sav'}), c))).toEqual([1]);
    expect(ids(runQuery(ISSUES, q({q: '#12'}), c))).toEqual([4]);
    expect(ids(runQuery(ISSUES, q({q: '12'}), c))).toEqual([4]);
  });

  test('the state comes from the context (the overlay), not the DTO', () => {
    expect(ids(runQuery(ISSUES, q(), ctx({...FACTS, 1: {...FACTS[1], state: 'closed'}})))).toEqual([4, 2]);
  });

  test('sorts', () => {
    const c = ctx(FACTS);
    const sorted = (sort: Query['sort']) => ids(runQuery(ISSUES, q({state: 'all'}, {sort}), c));
    expect(sorted('oldest')).toEqual([1, 2, 3, 4]);
    expect(sorted('recentupdate')).toEqual([1, 3, 2, 4]);
    expect(sorted('leastupdate')).toEqual([4, 2, 3, 1]);
    expect(sorted('mostcomment')).toEqual([3, 1, 4, 2]);
    expect(sorted('nearduedate')).toEqual([4, 2, 3, 1]); // no due date last, newest id first among them
    expect(sorted('farduedate')).toEqual([2, 4, 3, 1]);
    expect(sorted('priority')).toEqual([1, 2, 4, 3]); // urgent, low, then none (newest first)
  });

  test('groups: status (labels, then Forgejo state), priority, assignee, milestone', () => {
    const c = ctx(FACTS);
    const g = (group: Query['group']) => runQuery(ISSUES, q({state: 'all'}, {group}), c).rows.map((r) => (r.type === 'group' ? `[${r.label} ${String(r.count)}]` : r.id));
    expect(g('status')).toEqual(['[Backlog 1]', 2, '[Open 1]', 4, '[In Progress 1]', 1, '[Done 1]', 3]);
    expect(g('priority')).toEqual(['[Urgent 1]', 1, '[Low 1]', 2, '[No priority 2]', 4, 3]);
    expect(g('assignee')).toEqual(['[alice 1]', 2, '[dev 1]', 1, '[Unassigned 2]', 4, 3]);
    expect(g('milestone')).toEqual(['[Cycle 42 1]', 1, '[Later 1]', 4, '[No milestone 2]', 3, 2]);
  });

  test('10 000 issues: filter, group and sort in well under a frame', () => {
    const many: Issue[] = [];
    const facts: Record<number, {labels: number[]; assignees: number[]}> = {};
    for (let i = 1; i <= 10_000; i++) {
      many.push(issue(i, 1, i, `Issue ${String(i)} about ${i % 2 ? 'crash' : 'keyboard'}`, {
        state: i % 7 ? 'open' : 'closed', updated_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), milestone_id: i % 3,
      }));
      facts[i] = {labels: [1 + (i % 3), 4 + (i % 2), ...(i % 4 ? [6] : [])], assignees: i % 5 ? [1 + (i % 2)] : []};
    }
    const c = ctx(facts);
    runQuery(many, q(), c); // warm up the JIT
    const times: number[] = [];
    for (const query of [q(), q({labels: [6], q: 'crash'}, {sort: 'recentupdate', group: 'status'}), q({state: 'all'}, {sort: 'priority', group: 'assignee'})]) {
      const t0 = performance.now();
      const r = runQuery(many, query, c);
      times.push(performance.now() - t0);
      expect(r.ids.length).toBeGreaterThan(0);
    }
    console.warn(`runQuery over 10 000 issues: ${times.map((t) => t.toFixed(1)).join(' / ')} ms`);
    // A frame is 16 ms in the browser; Node in CI is slower and noisier, so assert loosely here (the e2e test measures in Chromium).
    expect(Math.max(...times)).toBeLessThan(80);
  });
});
