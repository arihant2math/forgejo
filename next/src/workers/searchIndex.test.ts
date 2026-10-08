// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {createIndex, type SearchDoc} from './searchIndex.ts';

const DOCS: SearchDoc[] = [
  {id: 1, title: 'Crash when saving a draft', repo: 'acme/website', number: 12},
  {id: 2, title: 'Dark theme contrast', repo: 'acme/website', number: 13},
  {id: 3, title: 'Saving fails offline', repo: 'acme/api-server', number: 4},
];

test('prefixes, typos, repository and number', () => {
  const ix = createIndex();
  expect(ix.upsert(DOCS)).toBe(3);
  expect(ix.search('sav', 10).hits.map((h) => h.id).sort()).toEqual([1, 3]);
  expect(ix.search('contarst', 10).hits.map((h) => h.id)).toEqual([2]);
  expect(ix.search('api saving', 10).hits.map((h) => h.id)).toEqual([3]);
  expect(ix.search('#12', 10).hits.map((h) => h.id)).toEqual([1]);
  expect(ix.search('  ', 10).hits).toEqual([]);
});

test('replace and remove', () => {
  const ix = createIndex();
  ix.upsert(DOCS);
  ix.upsert([{id: 2, title: 'Light theme', repo: 'acme/website', number: 13}]);
  expect(ix.search('dark', 10).hits).toEqual([]);
  expect(ix.search('light', 10).hits.map((h) => h.id)).toEqual([2]);
  expect(ix.remove([1, 99])).toBe(2);
  expect(ix.search('crash', 10).hits).toEqual([]);
});

test('10 000 issues: a query takes well under a frame', () => {
  const words = ['crash', 'save', 'theme', 'login', 'api', 'sync', 'offline', 'board', 'label', 'search', 'render', 'cache'];
  const ix = createIndex();
  const docs: SearchDoc[] = [];
  for (let i = 1; i <= 10_000; i++) docs.push({id: i, title: `${words[i % 12] ?? ''} ${words[(i * 7) % 12] ?? ''} issue ${String(i)}`, repo: `org${String(i % 20)}/repo${String(i % 50)}`, number: i});
  ix.upsert(docs);
  const times: number[] = [];
  for (const q of ['cra', 'theme log', 'offlne', 'org3 sync', '4242', 'render cache issue']) times.push(ix.search(q, 20).ms);
  times.sort((a, b) => a - b);
  // Node is faster than a browser worker; the browser numbers are in e2e/f6.spec.ts.
  expect(times.at(-1)).toBeLessThan(50);
});
