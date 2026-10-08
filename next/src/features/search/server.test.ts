// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {parseServerHits} from './server.ts';

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
