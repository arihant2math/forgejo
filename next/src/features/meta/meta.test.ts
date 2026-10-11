// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import {labelsSearch, milestonesSearch} from '../../app/search.ts';
import type {Label, Milestone} from '../../protocol/types.gen.ts';
import {countIssues, type IssueFacts, milestoneProgress} from './counts.ts';
import {
  draftOf, filterLabels, LABEL_PRESETS, labelEdit, labelProblems, labelValid, normalizeColor, sortLabels,
} from './labels.ts';
import {
  dateField, dueOnOf, excerpt, listMilestones, milestoneProblem, milestoneRows, overdue, sortMilestones,
} from './milestones.ts';
import {mergePending} from './writes.ts';

const label = (id: number, name: string, extra: Partial<Label> = {}): Label => ({
  id, repo_id: 1, org_id: 0, name, exclusive: false, description: '', color: '#e11d21', num_issues: 0, num_closed_issues: 0, created_at: '2026-01-01T00:00:00Z', ...extra,
});

const milestone = (id: number, title: string, extra: Partial<Milestone> = {}): Milestone => ({
  id, repo_id: 1, title, description: '', state: 'open', open_issues: 0, closed_issues: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra,
});

const issue = (state: string, labels: number[], milestone = 0, isPull = false): IssueFacts => ({state, labels, milestone, isPull});

describe('counts', () => {
  test('labels count open issues and pull requests apart; milestones open and closed', () => {
    const c = countIssues([
      issue('open', [1, 2], 7), issue('open', [1], 7, true), issue('closed', [1], 7), issue('closed', [2], 8), issue('open', [], 0),
    ]);
    expect(c.labels.get(1)).toEqual({issues: 1, pulls: 1});
    expect(c.labels.get(2)).toEqual({issues: 1, pulls: 0});
    expect(c.labels.has(3)).toBe(false);
    expect(c.milestones.get(7)).toEqual({open: 2, closed: 1});
    expect(c.milestones.get(8)).toEqual({open: 0, closed: 1});
    expect(c.milestones.has(0)).toBe(false);
  });

  test('a milestone\'s progress: open from here, closed from the server\'s total', () => {
    // In step with the server.
    expect(milestoneProgress({open_issues: 2, closed_issues: 6}, {open: 2, closed: 1})).toEqual({open: 2, closed: 6, total: 8, percent: 75});
    // Closed here, not synced yet: it moves from open to closed at once.
    expect(milestoneProgress({open_issues: 2, closed_issues: 6}, {open: 1, closed: 2})).toEqual({open: 1, closed: 7, total: 8, percent: 87});
    // The server lags a delta: never fewer closed than held here.
    expect(milestoneProgress({open_issues: 0, closed_issues: 0}, {open: 1, closed: 2})).toEqual({open: 1, closed: 2, total: 3, percent: 66});
    // None of its issues here yet: the server's counts.
    expect(milestoneProgress({open_issues: 3, closed_issues: 1}, undefined)).toEqual({open: 3, closed: 1, total: 4, percent: 25});
    expect(milestoneProgress({open_issues: 0, closed_issues: 0}, undefined)).toEqual({open: 0, closed: 0, total: 0, percent: 0});
  });
});

describe('labels', () => {
  const ls = [label(1, 'bug', {description: 'Something is broken'}), label(2, 'Docs'), label(3, 'area/api', {exclusive: true}), label(4, 'enhancement')];
  const counts = new Map([[1, {issues: 3, pulls: 1}], [4, {issues: 1, pulls: 0}], [3, {issues: 0, pulls: 4}]]);

  test('orders: by name (case-insensitive), reversed, by open items', () => {
    expect(sortLabels(ls, 'alphabetically', counts).map((l) => l.id)).toEqual([3, 1, 2, 4]);
    expect(sortLabels(ls, 'reversealphabetically', counts).map((l) => l.id)).toEqual([4, 2, 1, 3]);
    expect(sortLabels(ls, 'mostissues', counts).map((l) => l.id)).toEqual([3, 1, 4, 2]);
    expect(sortLabels(ls, 'leastissues', counts).map((l) => l.id)).toEqual([2, 4, 3, 1]);
  });

  test('search: every word in the name or the description', () => {
    expect(filterLabels(ls, 'broken').map((l) => l.id)).toEqual([1]);
    expect(filterLabels(ls, 'BUG something').map((l) => l.id)).toEqual([1]);
    expect(filterLabels(ls, 'api').map((l) => l.id)).toEqual([3]);
    expect(filterLabels(ls, '  ').length).toBe(4);
  });

  test('the search params', () => {
    expect(labelsSearch({q: 'x', sort: 'mostissues'})).toEqual({q: 'x', sort: 'mostissues'});
    expect(labelsSearch({q: ' ', sort: 'alphabetically'})).toEqual({});
    expect(labelsSearch({sort: 'nonsense'})).toEqual({});
  });

  test('colours', () => {
    expect(normalizeColor('ABC')).toBe('#aabbcc');
    expect(normalizeColor('#E11D21')).toBe('#e11d21');
    expect(normalizeColor(' e11d21 ')).toBe('#e11d21');
    for (const c of ['', '#ab', 'red', '#gggggg', '#e11d2122']) expect(normalizeColor(c), c).toBeUndefined();
    expect(LABEL_PRESETS).toHaveLength(16);
    for (const c of LABEL_PRESETS) expect(normalizeColor(c)).toBe(c);
  });

  test('the form', () => {
    const ok = {name: 'bug', description: '', color: '#e11d21', exclusive: false, archived: false};
    expect(labelProblems(ok)).toEqual({});
    expect(labelValid(ok)).toBe(true);
    expect(labelProblems({...ok, name: ' '}).name).toBeTruthy();
    expect(labelProblems({...ok, name: 'x'.repeat(51)}).name).toBeTruthy();
    expect(labelProblems({...ok, color: '#12'}).color).toBeTruthy();
    expect(labelProblems({...ok, description: 'x'.repeat(201)}).description).toBeTruthy();
    // Exclusive without a scope is only a hint (Forgejo accepts it, it just has no effect).
    expect(labelValid({...ok, exclusive: true})).toBe(true);
    expect(labelProblems({...ok, exclusive: true}).exclusive).toBeTruthy();
    expect(labelProblems({...ok, name: 'kind/bug', exclusive: true}).exclusive).toBeUndefined();
  });

  test('an edit sends what changed', () => {
    const l = label(1, 'bug', {color: '#E11D21'});
    expect(labelEdit(l, draftOf(l))).toBeUndefined();
    expect(labelEdit(l, {...draftOf(l), name: ' bugs ', color: 'fbca04', archived: true})).toEqual({name: 'bugs', color: '#fbca04', is_archived: true});
  });
});

describe('milestones', () => {
  const ms = [
    milestone(1, 'v1', {due_on: '2026-03-01T00:00:00Z', open_issues: 1, closed_issues: 3, updated_at: '2026-02-01T00:00:00Z'}),
    milestone(2, 'v2', {due_on: '2026-06-01T00:00:00Z', open_issues: 4, closed_issues: 0, description: 'Second **release**', updated_at: '2026-05-01T00:00:00Z'}),
    milestone(3, 'Backlog', {open_issues: 2, closed_issues: 2}),
    milestone(4, 'v0', {state: 'closed', closed_issues: 5}),
  ];
  const rows = milestoneRows(ms, new Map());

  test('tabs and search', () => {
    expect(listMilestones(rows, {}).map((r) => r.milestone.id)).toEqual([1, 2, 3]);
    expect(listMilestones(rows, {state: 'closed'}).map((r) => r.milestone.id)).toEqual([4]);
    expect(listMilestones(rows, {q: 'release'}).map((r) => r.milestone.id)).toEqual([2]);
  });

  test('orders; undated last in both date orders', () => {
    const ids = (sort: Parameters<typeof sortMilestones>[1]) => sortMilestones(rows.slice(0, 3), sort).map((r) => r.milestone.id);
    expect(ids('closestduedate')).toEqual([1, 2, 3]);
    expect(ids('furthestduedate')).toEqual([2, 1, 3]);
    expect(ids('recentupdate')).toEqual([2, 1, 3]);
    expect(ids('mostcomplete')).toEqual([1, 3, 2]);
    expect(ids('leastcomplete')).toEqual([2, 3, 1]);
    expect(ids('mostissues')).toEqual([3, 1, 2]); // four each: by title
    expect(ids('leastissues')).toEqual([3, 1, 2]);
    expect(ids('name')).toEqual([3, 1, 2]);
  });

  test('the search params', () => {
    expect(milestonesSearch({state: 'closed', sort: 'mostcomplete', q: 'v'})).toEqual({state: 'closed', sort: 'mostcomplete', q: 'v'});
    expect(milestonesSearch({state: 'open', sort: 'closestduedate'})).toEqual({});
    expect(milestonesSearch({state: 'all', sort: 'x'})).toEqual({});
  });

  test('overdue: an open milestone past its date', () => {
    const now = Date.parse('2026-04-01T00:00:00Z');
    expect(overdue(ms[0] ?? milestone(0, ''), now)).toBe(true);
    expect(overdue(ms[1] ?? milestone(0, ''), now)).toBe(false);
    expect(overdue(ms[2] ?? milestone(0, ''), now)).toBe(false);
    expect(overdue({state: 'closed', due_on: '2026-03-01T00:00:00Z'}, now)).toBe(false);
  });

  test('a description\'s excerpt is plain text', () => {
    expect(excerpt('# Goals\n\n- Ship **the** [API](https://x.test)\n- `fast`')).toBe('Goals Ship the API fast');
    expect(excerpt('```\ncode\n```\nAfter')).toBe('After');
    expect(excerpt('word '.repeat(60), 20)).toBe('word word word word…');
  });

  test('due dates in the form and on the wire', () => {
    expect(dateField('2026-10-31T23:59:59Z')).toBe('2026-10-31');
    expect(dateField(undefined)).toBe('');
    expect(dueOnOf('2026-10-31')).toBe('2026-10-31T23:59:59Z');
    // Clearing it: Forgejo's "no deadline" (its year is 9999 in every time zone).
    expect(dueOnOf('')).toBe('9999-12-31T12:00:00Z');
    expect(milestoneProblem({title: ' ', description: '', due: ''})).toBeTruthy();
    expect(milestoneProblem({title: 'v3', description: '', due: '2026-1-1'})).toBeTruthy();
    expect(milestoneProblem({title: 'v3', description: '', due: '2026-10-31'})).toBeUndefined();
  });
});

test('pending writes: a change shows on its row, a deletion hides it, a creation adds one (its repository only)', () => {
  const rows = [label(1, 'bug'), label(2, 'docs'), label(3, 'ui')];
  const edits = new Map([[1, {patch: {name: 'bugs', archived_at: undefined}}], [2, {patch: null}]]);
  const created = [label(-1, 'new'), label(-2, 'elsewhere', {repo_id: 9})];
  const out = mergePending(rows, edits, created, 1);
  expect(out.map((l) => [l.id, l.name])).toEqual([[1, 'bugs'], [3, 'ui'], [-1, 'new']]);
  expect(rows[0]?.name).toBe('bug');
});
