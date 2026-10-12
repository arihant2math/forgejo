// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test, vi} from 'vitest';
import {online} from '../../app/api.ts';
import {createApp} from '../../app/store.ts';
import {parseServerHits, relevantHits, searchServerOrgs} from './server.ts';

vi.mock('../../app/api.ts', () => ({online: vi.fn()}));

test('organization search finds names outside memberships and beyond the first page', async () => {
  vi.mocked(online).mockResolvedValueOnce(Array.from({length: 50}, (_, id) => ({id, name: `unrelated${String(id)}`})))
    .mockResolvedValueOnce([{id: 51, name: 'acme', full_name: 'Acme Corp'}, {id: 52, name: 'openlab', full_name: 'Open Laboratory'}]);
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, undefined);
  expect(await searchServerOrgs(app, 'ACME Corp', new AbortController().signal)).toEqual([
    {id: 51, login: 'acme', fullName: 'Acme Corp', organization: true},
  ]);
  expect(vi.mocked(online).mock.calls.map(([, options]) => options.path)).toEqual(['/orgs?limit=50&page=1', '/orgs?limit=50&page=2']);
});

test('parseServerHits keeps well-formed issues only', () => {
  expect(parseServerHits([
    {id: 5, number: 2, title: 'A', state: 'closed', pull_request: null, repository: {owner: 'acme', name: 'web', full_name: 'acme/web'}},
    {id: 6, number: 3, title: 'B', state: 'open', pull_request: {merged: false}, repository: {owner: 'acme', name: 'web', full_name: 'acme/web'}},
    {id: 9, number: 5, title: 'E', state: 'closed', pull_request: {merged: true}, repository: {owner: 'acme', name: 'web', full_name: 'acme/web'}},
    {id: '7', number: 4, title: 'C', repository: {owner: 'a', name: 'b', full_name: 'a/b'}},
    {id: 8, number: 4, title: 'D'},
  ])).toEqual([
    {id: 5, number: 2, title: 'A', state: 'closed', pull: false, merged: false, owner: 'acme', repo: 'web', fullName: 'acme/web'},
    {id: 6, number: 3, title: 'B', state: 'open', pull: true, merged: false, owner: 'acme', repo: 'web', fullName: 'acme/web'},
    {id: 9, number: 5, title: 'E', state: 'closed', pull: true, merged: true, owner: 'acme', repo: 'web', fullName: 'acme/web'},
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
