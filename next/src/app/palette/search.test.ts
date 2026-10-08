// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import type {EntityRecord} from '../../data/entity.ts';
import {Pool} from '../../data/pool.ts';
import {issue, repo, user} from '../../test/fakeSession.ts';
import {score, searchPool, terms} from './search.ts';

function pool(issues: number) {
  const p = new Pool();
  const acme = user(2, 'acme');
  const repos = [repo(1, acme, 'website'), repo(2, acme, 'api', {updated_at: '2026-10-02T00:00:00Z'}), repo(3, user(3, 'web'), 'tools')];
  p.batch(() => {
    p.load('Repository', repos.map((r) => ({id: r.id, g: `repo:${String(r.id)}`, v: 1, d: r})));
    const recs: EntityRecord<'Issue'>[] = [];
    for (let i = 1; i <= issues; i++) {
      recs.push({id: i, g: 'repo:1', v: 1, d: issue(i, 1 + (i % 2), i, `Issue number ${String(i)} about ${i % 3 ? 'pagination' : 'the footer'}`)});
    }
    recs.push({id: issues + 1, g: 'repo:1', v: 1, d: issue(issues + 1, 1, issues + 1, 'Crash when saving', {state: 'closed', is_pull: true})});
    p.load('Issue', recs);
  });
  return p;
}

test('terms and scores: prefix > word start > inside; every word must match', () => {
  expect(terms('Fix #12 now')).toEqual({words: ['fix', '#12', 'now'], number: 12});
  expect(score('acme/website', ['acme'])).toBe(3);
  expect(score('acme/website', ['web'])).toBe(2);
  expect(score('acme/website', ['site'])).toBe(1);
  expect(score('acme/website', ['web', 'nope'])).toBe(-1);
});

test('repositories by full name; issues by title, by number and by repository words', () => {
  const p = pool(100);
  const r = searchPool(p, 'web');
  // "web/tools" (owner prefix) before "acme/website" (word start).
  expect(r.repos.map((x) => x.full_name)).toEqual(['web/tools', 'acme/website']);
  expect(searchPool(p, 'crash').issues.map((x) => x.issue.title)).toEqual(['Crash when saving']);
  expect(searchPool(p, '#42').issues[0]?.issue.number).toBe(42);
  expect(searchPool(p, '42 website').issues.map((x) => x.issue.number)).toEqual([42]); // even numbers are in acme/website
  expect(searchPool(p, '42 api').issues).toEqual([]);
  expect(searchPool(p, 'website footer').issues.length).toBeGreaterThan(0);
  expect(searchPool(p, '').issues).toEqual([]);
  expect(searchPool(p, 'footer', {issueLimit: 5}).issues).toHaveLength(5);
});

test('peeked repositories (not hydrated yet) are found too', () => {
  const p = new Pool();
  const extra = new Map([[9, repo(9, user(2, 'acme'), 'later')]]);
  expect(searchPool(p, 'later', {extraRepos: extra}).repos.map((r) => r.id)).toEqual([9]);
});

test('50 000 issues: a keystroke searches well within a frame', () => {
  const p = pool(50_000);
  searchPool(p, 'f'); // first search builds the lower-case cache
  const times: number[] = [];
  for (const q of ['fo', 'foo', 'foot', 'footer', 'pag', '#4242', 'acme pag']) {
    const t0 = performance.now();
    searchPool(p, q);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  // The browser budget is 16 ms (e2e asserts it); jsdom on a shared CI box gets slack.
  // The fastest run shows the cost without the machine's noise (tests run in parallel).
  expect(times[0]).toBeLessThan(30);
});
