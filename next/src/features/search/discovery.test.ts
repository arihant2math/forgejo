// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test, vi} from 'vitest';
import {discover, discoverySearch} from './discovery.ts';
import {online, send} from '../../app/api.ts';
import type {App} from '../../app/store.ts';

vi.mock('../../app/api.ts', () => ({online: vi.fn(), send: vi.fn()}));
const app = {} as App;

test('URL input is normalized and incompatible sort choices are discarded', () => {
  expect(discoverySearch({type: 'nope', page: '-1', archived: 'junk'})).toMatchObject({type: 'repositories', page: 1, archived: ''});
  expect(discoverySearch({type: 'users', sort: 'stars', page: '3'})).toMatchObject({type: 'users', sort: 'updated', page: 3});
  expect(discoverySearch({type: 'issues', sort: 'alpha'}).sort).toBe('updated');
});

test('repository filters and pagination reach the server without truncating', async () => {
  vi.mocked(online).mockResolvedValue({rows: [{id: 1, title: 'outside/repo', detail: '', path: '/outside/repo'}], total: 120});
  const result = await discover(app, discoverySearch({q: 'repo', archived: 'false', language: 'Go', page: 2, sort: 'stars'}), new AbortController().signal);
  expect(result.total).toBe(120);
  const request = vi.mocked(online).mock.calls.at(-1)?.[1];
  expect(request?.api).toBe('sync');
  const query = new URL(request?.path ?? '', 'https://example.test').searchParams;
  expect(Object.fromEntries(query)).toMatchObject({language: 'Go', archived: 'false', page: '2', sort: 'stars'});
});

test('issue search preserves indexer hits and total count, links pulls to their own view', async () => {
  vi.mocked(send).mockResolvedValue({value: [{id: 3, number: 8, title: 'A comment-only match', pull_request: {}, state: 'closed', repository: {owner: 'acme', name: 'web', full_name: 'acme/web'}}], totalCount: 200, syncId: undefined});
  const result = await discover(app, discoverySearch({q: 'in a comment', type: 'pulls', state: 'closed', page: 2}), new AbortController().signal);
  expect(result).toMatchObject({total: 200, rows: [{path: '/acme/web/pulls/8'}]});
  expect(vi.mocked(send).mock.calls.at(-1)?.[1].path).toContain('state=closed');
});
