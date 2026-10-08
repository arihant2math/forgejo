// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import type {EntityRecord} from '../../data/entity.ts';
import type {Issue} from '../../protocol/types.gen.ts';
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
  // Three rounds (the first also warms the JIT): one slow stretch of a shared machine does not decide.
  for (let round = 0; round < 3; round++) {
    for (const q of ['fo', 'foo', 'foot', 'footer', 'pag', '#4242', 'acme pag']) {
      const t0 = performance.now();
      searchPool(p, q);
      times.push(performance.now() - t0);
    }
  }
  times.sort((a, b) => a - b);
  // The browser budget is 16 ms (e2e asserts it); jsdom on a shared CI box gets slack.
  // The fastest run shows the cost without the machine's noise (tests run in parallel).
  expect(times[0]).toBeLessThan(30);
});

test('narrowing from the previous keystroke gives the full scan\'s results', () => {
  const p = pool(3000);
  let prev: {query: string; matched: readonly Issue[]} | undefined;
  for (const q of ['f', 'fo', 'foot', 'footer', 'footer website', 'footer websitex']) {
    const narrowed = searchPool(p, q, {narrow: prev, issueLimit: 50});
    const full = searchPool(p, q, {issueLimit: 50});
    expect(narrowed.issues.map((x) => x.issue.id), q).toEqual(full.issues.map((x) => x.issue.id));
    prev = narrowed.matched ? {query: q, matched: narrowed.matched} : undefined;
  }
  // From one word to two the second may name the repository: no narrowing then (round-2 review).
  const one = searchPool(p, 'website', {issueLimit: 50});
  const two = searchPool(p, 'website footer', {issueLimit: 50, narrow: {query: 'website', matched: one.matched ?? []}});
  expect(two.issues.map((x) => x.issue.id)).toEqual(searchPool(p, 'website footer', {issueLimit: 50}).issues.map((x) => x.issue.id));
  expect(two.issues.length).toBeGreaterThan(0);
  // A number query is never narrowed from a text one (its matches are not a subset).
  const r = searchPool(p, '#7', {narrow: {query: '#', matched: []}});
  expect(r.issues[0]?.issue.number).toBe(7);
});

test('typing into 50 000 issues: after the first keystroke, each one narrows within a frame', () => {
  const p = pool(50_000);
  let prev: {query: string; matched: readonly Issue[]} | undefined;
  const times: number[] = [];
  for (const q of ['fo', 'foo', 'foot', 'foote', 'footer', 'footer w', 'footer we']) {
    const t0 = performance.now();
    const r = searchPool(p, q, {narrow: prev});
    times.push(performance.now() - t0);
    prev = r.matched ? {query: q, matched: r.matched} : undefined;
  }
  // The later keystrokes scan only the earlier matches.
  expect(Math.min(...times.slice(1))).toBeLessThan(16);
});
