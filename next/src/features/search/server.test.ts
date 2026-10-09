// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {parseServerHits, relevantHits} from './server.ts';

test('parseServerHits keeps well-formed issues only', () => {
  expect(parseServerHits([
    {id: 5, number: 2, title: 'A', state: 'closed', pull_request: null, repository: {owner: 'acme', name: 'web', full_name: 'acme/web'}},
    {id: 6, number: 3, title: 'B', state: 'open', pull_request: {merged: false}, repository: {owner: 'acme', name: 'web', full_name: 'acme/web'}},
    {id: '7', number: 4, title: 'C', repository: {owner: 'a', name: 'b', full_name: 'a/b'}},
    {id: 8, number: 4, title: 'D'},
  ])).toEqual([
    {id: 5, number: 2, title: 'A', state: 'closed', pull: false, owner: 'acme', repo: 'web', fullName: 'acme/web'},
    {id: 6, number: 3, title: 'B', state: 'open', pull: true, owner: 'acme', repo: 'web', fullName: 'acme/web'},
  ]);
  expect(parseServerHits({message: 'nope'})).toEqual([]);
});

test('server hits are kept only when the query is in their title or description', () => {
  const repository = {owner: 'acme', name: 'web', full_name: 'acme/web'};
  const list = [
    {id: 1, number: 1, title: 'Atlas 1.0 release', body: '', repository},
    {id: 2, number: 2, title: 'Health check path', body: 'Needed before 1.0 of atlas.', repository},
    {id: 3, number: 3, title: 'CrashLoopBackOff', body: 'nothing related', repository},
    {id: 4, number: 4, title: '東京 tiles', body: null, repository},
  ];
  expect(relevantHits(list, 'atlas 1.0').map((h) => h.id)).toEqual([1, 2]);
  expect(relevantHits(list, '東京').map((h) => h.id)).toEqual([4]);
});
