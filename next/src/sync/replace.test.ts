// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {describe, expect, test} from 'vitest';
import type {ModelName, ModelTypes} from '../data/models.ts';
import {Pool} from '../data/pool.ts';
import type {BootstrapEnd, BootstrapHeader} from '../protocol/types.gen.ts';
import {below, parseCursor, replaceGroup, unixSeconds} from './replace.ts';

const OLD = '2025-01-01T00:00:00Z'; // before the cutoff
const NEW = '2026-06-01T00:00:00Z';
const CUTOFF = unixSeconds('2026-01-01T00:00:00Z');
const G = 'repo:1';

function put<M extends ModelName>(p: Pool, m: M, id: number, v: number, d: Partial<ModelTypes[M]>, g = G): void {
  p.put(m, id, g, v, {id, ...d} as ModelTypes[M]);
}

function ids(p: Pool, m: ModelName): number[] {
  return [...p.model(m).all()].map((e) => e.id).sort((a, b) => a - b);
}

function header(h: Partial<BootstrapHeader>, noCutoff = false): BootstrapHeader {
  const out: BootstrapHeader = {type: 'header', group: G, watermark: 100, units: ['issues'], tier: 'summary', schemas: {}, closed_before: CUTOFF, ...h};
  if (noCutoff) delete out.closed_before;
  return out;
}

const END: BootstrapEnd = {type: 'end', count: 0, refs: []};

/** A repository held with an open issue (1), a closed old issue (2) with a label, a PR and an auto-merge, and statuses. */
function seeded(): Pool {
  const p = new Pool();
  put(p, 'Issue', 1, 10, {state: 'open', updated_at: NEW});
  put(p, 'Issue', 2, 10, {state: 'closed', updated_at: OLD});
  put(p, 'Issue', 3, 10, {state: 'closed', updated_at: NEW});
  put(p, 'IssueLabel', 20, 10, {issue_id: 2, label_id: 5});
  put(p, 'IssueLabel', 10, 10, {issue_id: 1, label_id: 5});
  put(p, 'PullRequest', 30, 10, {issue_id: 2});
  put(p, 'AutoMerge', 40, 10, {pull_id: 30});
  put(p, 'CommitStatus', 50, 10, {updated_at: OLD});
  put(p, 'CommitStatus', 51, 10, {updated_at: NEW});
  put(p, 'Label', 5, 10, {repo_id: 1});
  return p;
}

describe('summary replacement', () => {
  test('drops what the response left out, keeps the closed tier', () => {
    const p = seeded();
    const n = replaceGroup(p, {group: G, header: header({}), end: END, received: new Map([['Label', new Set([5])]]), heldUnits: ['issues']});
    expect(ids(p, 'Issue')).toEqual([2]); // 1 (open) and 3 (closed recently) are in scope
    expect(ids(p, 'IssueLabel')).toEqual([20]);
    expect(ids(p, 'PullRequest')).toEqual([30]);
    expect(ids(p, 'AutoMerge')).toEqual([40]);
    expect(ids(p, 'CommitStatus')).toEqual([50]);
    expect(ids(p, 'Label')).toEqual([5]);
    expect(n).toBe(4);
  });

  test('keeps entities newer than the watermark', () => {
    const p = seeded();
    put(p, 'Issue', 1, 101, {state: 'open', updated_at: NEW});
    replaceGroup(p, {group: G, header: header({}), end: END, received: new Map(), heldUnits: ['issues']});
    expect(ids(p, 'Issue')).toEqual([1, 2]);
  });

  test('other units: the whole group is in scope', () => {
    const p = seeded();
    replaceGroup(p, {group: G, header: header({units: ['issues', 'pulls']}), end: END, received: new Map(), heldUnits: ['issues']});
    expect(ids(p, 'Issue')).toEqual([]);
    expect(ids(p, 'CommitStatus')).toEqual([]);
    expect(ids(p, 'AutoMerge')).toEqual([]);
  });

  test('units compare as sets', () => {
    const p = seeded();
    replaceGroup(p, {group: G, header: header({units: ['pulls', 'issues']}), end: END, received: new Map(), heldUnits: ['issues', 'pulls']});
    expect(ids(p, 'Issue')).toEqual([2]);
  });

  test('a model filter limits the scope', () => {
    const p = seeded();
    replaceGroup(p, {group: G, header: header({models: ['Label']}), end: END, received: new Map(), heldUnits: ['issues']});
    expect(ids(p, 'Label')).toEqual([]);
    expect(ids(p, 'Issue')).toEqual([1, 2, 3]);
  });

  test('other groups are left alone', () => {
    const p = seeded();
    put(p, 'Issue', 9, 10, {state: 'open', updated_at: NEW}, 'repo:2');
    replaceGroup(p, {group: G, header: header({}), end: END, received: new Map(), heldUnits: undefined});
    expect(p.model('Issue').get(9)).toBeDefined();
  });

  test('the floor rejects stale states in scope, not the closed tier', () => {
    const p = seeded();
    replaceGroup(p, {group: G, header: header({}), end: END, received: new Map(), heldUnits: ['issues']});
    // An open issue as of v 90 ≤ watermark that the response did not contain: stale.
    put(p, 'Issue', 7, 90, {state: 'open', updated_at: NEW});
    expect(p.model('Issue').get(7)).toBeUndefined();
    // An old closed issue: the summary does not cover it.
    put(p, 'Issue', 8, 90, {state: 'closed', updated_at: OLD});
    expect(p.model('Issue').get(8)).toBeDefined();
    // A label of a held closed-tier issue, an aged status: not covered either.
    put(p, 'IssueLabel', 21, 90, {issue_id: 2, label_id: 6});
    put(p, 'CommitStatus', 52, 90, {updated_at: OLD});
    expect(ids(p, 'IssueLabel')).toEqual([20, 21]);
    expect(ids(p, 'CommitStatus')).toEqual([50, 52]);
    // A newer state passes.
    put(p, 'Issue', 7, 101, {state: 'open', updated_at: NEW});
    expect(p.model('Issue').get(7)).toBeDefined();
  });
});

describe('user group', () => {
  test('old read notifications are kept', () => {
    const p = new Pool();
    const g = 'user:1';
    put(p, 'Notification', 1, 10, {status: 'read', updated_at: OLD}, g);
    put(p, 'Notification', 2, 10, {status: 'read', updated_at: NEW}, g);
    put(p, 'Notification', 3, 10, {status: 'unread', updated_at: OLD}, g);
    put(p, 'Star', 4, 10, {}, g);
    replaceGroup(p, {group: g, header: header({group: g, tier: 'full', units: ['self']}), end: END, received: new Map(), heldUnits: ['self']});
    expect(ids(p, 'Notification')).toEqual([1]);
    expect(ids(p, 'Star')).toEqual([]);
  });

  test('without closed_before everything is in scope', () => {
    const p = new Pool();
    put(p, 'User', 1, 10, {login: 'a'}, 'profiles:public');
    put(p, 'User', 2, 10, {login: 'b'}, 'profiles:public');
    replaceGroup(p, {
      group: 'profiles:public', header: header({group: 'profiles:public', tier: 'full', units: []}, true),
      end: END, received: new Map([['User', new Set([2])]]), heldUnits: [],
    });
    expect(ids(p, 'User')).toEqual([2]);
  });
});

describe('closed pages', () => {
  const at = (s: number) => new Date(s * 1000).toISOString().replace('.000', '');

  test('replaces the closed tier between its cursors', () => {
    const p = new Pool();
    // Closed issues, (updated, id): (1000,1) (2000,2) (2000,3) (3000,4); issue 5 is open.
    put(p, 'Issue', 1, 10, {state: 'closed', updated_at: at(1000)});
    put(p, 'Issue', 2, 10, {state: 'closed', updated_at: at(2000)});
    put(p, 'Issue', 3, 10, {state: 'closed', updated_at: at(2000)});
    put(p, 'Issue', 4, 10, {state: 'closed', updated_at: at(3000)});
    put(p, 'Issue', 5, 10, {state: 'open', updated_at: at(2500)});
    put(p, 'IssueLabel', 11, 10, {issue_id: 3, label_id: 1});
    put(p, 'IssueLabel', 12, 10, {issue_id: 2, label_id: 1});
    put(p, 'IssueLabel', 13, 10, {issue_id: 1, label_id: 1});
    // Page: before "3000" (exclusive), next "2000.2" (inclusive): the range holds (2000,2), (2000,3).
    // The page contained issue 3 (not 2) and none of the labels.
    replaceGroup(p, {
      group: G, header: header({tier: 'closed', before: '3000', watermark: 100}, true),
      end: {type: 'end', count: 1, refs: [], next: '2000.2'},
      received: new Map([['Issue', new Set([3])]]), heldUnits: ['issues'], summaryClosedBefore: 5000,
    });
    expect(ids(p, 'Issue')).toEqual([1, 3, 4, 5]);
    expect(ids(p, 'IssueLabel')).toEqual([13]);
  });

  test('the last page reaches down to the oldest', () => {
    const p = new Pool();
    put(p, 'Issue', 1, 10, {state: 'closed', updated_at: at(1000)});
    put(p, 'Issue', 2, 10, {state: 'closed', updated_at: at(6000)}); // newer than the summary's cutoff: not the closed tier
    replaceGroup(p, {
      group: G, header: header({tier: 'closed', before: '5000'}, true),
      end: END, received: new Map(), heldUnits: ['issues'], summaryClosedBefore: 5000,
    });
    expect(ids(p, 'Issue')).toEqual([2]);
  });
});

test('cursors', () => {
  expect(parseCursor('1700000000')).toEqual({updated: 1700000000, id: 0});
  expect(parseCursor('1700000000.42')).toEqual({updated: 1700000000, id: 42});
  expect(parseCursor('0')).toBeUndefined();
  expect(parseCursor('17.0')).toBeUndefined();
  expect(parseCursor('x')).toBeUndefined();
  const c = {updated: 100, id: 5};
  expect(below(99, 1000, c)).toBe(true);
  expect(below(100, 4, c)).toBe(true);
  expect(below(100, 5, c)).toBe(false);
  expect(below(100, 1, {updated: 100, id: 0})).toBe(false);
  expect(unixSeconds('2026-01-01T00:00:01Z')).toBe(1767225601);
});
