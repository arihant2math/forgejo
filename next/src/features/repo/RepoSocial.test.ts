// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {beforeEach, expect, test, vi} from 'vitest';
import {online, RequestFailed} from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import {RepoSocialState} from './RepoSocial.tsx';

vi.mock('../../app/api.ts', async (original) => ({...await original(), online: vi.fn()}));
vi.mock('../../app/notices.ts', () => ({notify: vi.fn()}));
const app = {} as App;
beforeEach(() => { vi.mocked(online).mockReset(); });

test('loads each state once, interpreting only 404 as not starred or watching', async () => {
  vi.mocked(online).mockRejectedValue(new RequestFailed(404, 'Not found'));
  const state = new RepoSocialState(4, 2);
  await state.load(app, 'dev', 'repo');
  expect(state.ready).toBe(true);
  expect(state.starred).toBe(false);
  expect(state.watching).toBe(false);
  await state.load(app, 'dev', 'repo');
  expect(online).toHaveBeenCalledTimes(2);
  const failed = new RepoSocialState(4, 2);
  vi.mocked(online).mockRejectedValue(new RequestFailed(403, 'Forbidden'));
  await failed.load(app, 'dev', 'repo');
  expect(failed.ready).toBe(false);
});

test('optimistic counts roll back on failure, and successful watches use the subscription API', async () => {
  const state = new RepoSocialState(4, 2);
  state.ready = true;
  let reject!: (error: Error) => void;
  vi.mocked(online).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const pending = state.toggle(app, 'dev', 'repo', 'star');
  expect(state.starred).toBe(true);
  expect(state.stars).toBe(5);
  expect(state.pending).toBe(true);
  await state.toggle(app, 'dev', 'repo', 'watch');
  expect(online).toHaveBeenCalledTimes(1);
  reject(new RequestFailed(500, 'Failed'));
  await pending;
  expect(state.starred).toBe(false);
  expect(state.stars).toBe(4);
  expect(state.pending).toBe(false);
  vi.mocked(online).mockResolvedValue(undefined);
  await state.toggle(app, 'dev', 'repo', 'watch');
  expect(state.watching).toBe(true);
  expect(state.watchers).toBe(3);
  expect(online).toHaveBeenLastCalledWith(app, {api: 'v1', method: 'PUT', path: '/repos/dev/repo/subscription'});
  await state.toggle(app, 'dev', 'repo', 'watch');
  expect(state.watchers).toBe(2);
  expect(online).toHaveBeenLastCalledWith(app, {api: 'v1', method: 'DELETE', path: '/repos/dev/repo/subscription'});
});
