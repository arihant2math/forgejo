// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observable, runInAction} from 'mobx';
import {beforeEach, expect, test, vi} from 'vitest';
import {online, onlineWrite, RequestFailed} from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import {levelOf, RepoSocialState, type WatchFlags, watchedParts} from './RepoSocial.tsx';

vi.mock('../../app/api.ts', async (original) => ({...await original(), online: vi.fn(), onlineWrite: vi.fn()}));
vi.mock('../../app/notices.ts', () => ({notify: vi.fn()}));
const app = {} as App;
beforeEach(() => {
  vi.mocked(online).mockReset();
  vi.mocked(onlineWrite).mockReset();
});

function pool(stars: number | undefined, watchers: number | undefined, watch?: WatchFlags) {
  const p = observable({stars, watchers, watch});
  let release: () => void = () => undefined;
  const live = {
    stars: () => p.stars, watchers: () => p.watchers, watch: () => p.watch,
    synced: vi.fn(() => new Promise<void>((resolve) => { release = resolve; })),
  };
  return {p, live, arrive: () => { release(); }};
}

const answered = {totalCount: undefined, value: undefined, syncId: 7};

test('loads each state once, interpreting only 404 as not starred or watching', async () => {
  vi.mocked(online).mockRejectedValue(new RequestFailed(404, 'Not found'));
  const state = new RepoSocialState(pool(4, 2).live);
  await state.load(app, 'dev', 'repo');
  expect(state.ready).toBe(true);
  expect(state.starred).toBe(false);
  expect(state.watching).toBe(false);
  await state.load(app, 'dev', 'repo');
  expect(online).toHaveBeenCalledTimes(2);
  const failed = new RepoSocialState(pool(4, 2).live);
  vi.mocked(online).mockRejectedValue(new RequestFailed(403, 'Forbidden'));
  await failed.load(app, 'dev', 'repo');
  expect(failed.ready).toBe(false);
});

test('the counts are the pool\'s, live: none before the repository is there, then what it says', () => {
  const {p, live} = pool(undefined, undefined);
  const state = new RepoSocialState(live);
  expect(state.stars).toBeUndefined();
  expect(state.watchers).toBeUndefined();
  runInAction(() => { p.stars = 7; p.watchers = 51; });
  expect(state.stars).toBe(7);
  expect(state.watchers).toBe(51);
  runInAction(() => { p.stars = 6; });
  expect(state.stars).toBe(6);
});

test('a star shows the real count + 1 until the pool holds it, and rolls back on failure', async () => {
  const {p, live, arrive} = pool(2, 50);
  const state = new RepoSocialState(live);
  state.ready = true;
  let reject!: (error: Error) => void;
  vi.mocked(onlineWrite).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const failing = state.toggleStar(app, 'dev', 'repo');
  expect(state.starred).toBe(true);
  expect(state.stars).toBe(3);
  expect(state.pending).toBe(true);
  await state.setWatch(app, 'dev', 'repo', 'all');
  expect(onlineWrite).toHaveBeenCalledTimes(1);
  reject(new RequestFailed(500, 'Failed'));
  await failing;
  expect(state.starred).toBe(false);
  expect(state.stars).toBe(2);
  expect(state.pending).toBe(false);

  vi.mocked(onlineWrite).mockResolvedValue(answered);
  const starring = state.toggleStar(app, 'dev', 'repo');
  await vi.waitFor(() => { expect(state.pending).toBe(false); });
  expect(onlineWrite).toHaveBeenLastCalledWith(app, {api: 'v1', method: 'PUT', path: '/user/starred/dev/repo'});
  expect(live.synced).toHaveBeenCalledWith(7);
  expect(state.stars).toBe(3);
  // A pool count that includes another user's change must not receive the optimistic delta again.
  runInAction(() => { p.stars = 4; });
  expect(state.stars).toBe(4);
  arrive();
  await starring;
  expect(state.adjust.stars).toBeUndefined();
  expect(state.stars).toBe(4);
});

test('watching uses the subscription API; the watcher count follows the pool', async () => {
  const {p, live, arrive} = pool(4, 2);
  const state = new RepoSocialState(live);
  state.ready = true;
  vi.mocked(onlineWrite).mockResolvedValue(answered);
  const watching = state.setWatch(app, 'dev', 'repo', 'all');
  expect(state.watching).toBe(true);
  expect(state.level).toBe('all');
  expect(state.watchers).toBe(3);
  await vi.waitFor(() => { expect(state.pending).toBe(false); });
  expect(onlineWrite).toHaveBeenLastCalledWith(app, {api: 'v1', method: 'PUT', path: '/repos/dev/repo/subscription'});
  runInAction(() => { p.watchers = 3; p.watch = {issues: true, pull_requests: true, releases: true}; });
  arrive();
  await watching;
  expect(state.level).toBe('all');
  expect(state.watchers).toBe(3);
  const unwatching = state.setWatch(app, 'dev', 'repo', 'none');
  expect(state.watchers).toBe(2);
  expect(state.level).toBe('none');
  await vi.waitFor(() => { expect(state.pending).toBe(false); });
  expect(onlineWrite).toHaveBeenLastCalledWith(app, {api: 'v1', method: 'DELETE', path: '/repos/dev/repo/subscription'});
  runInAction(() => { p.watchers = 2; p.watch = {issues: false, pull_requests: false, releases: false}; });
  arrive();
  await unwatching;
  expect(state.level).toBe('none');
  expect(state.watchers).toBe(2);
});

test('a releases-only watch (set in the classic UI) is shown as such, never as "All activity"', async () => {
  const {live} = pool(4, 5, {issues: false, pull_requests: false, releases: true});
  const state = new RepoSocialState(live);
  vi.mocked(online).mockResolvedValue({subscribed: true});
  await state.load(app, 'dev', 'repo');
  expect(state.watching).toBe(true);
  expect(state.level).toBe('custom');
  expect(state.parts).toBe('releases');
  vi.mocked(onlineWrite).mockResolvedValue({...answered, syncId: undefined});
  void state.setWatch(app, 'dev', 'repo', 'all');
  await vi.waitFor(() => { expect(state.pending).toBe(false); });
  expect(state.level).toBe('all');
  expect(state.watchers).toBe(5);
});

test('watching without the pool\'s Watch row is "unknown", not "All activity"', async () => {
  const state = new RepoSocialState(pool(1, 1).live);
  vi.mocked(online).mockResolvedValue({subscribed: true});
  await state.load(app, 'dev', 'repo');
  expect(state.watching).toBe(true);
  expect(state.level).toBe('unknown');
});

test('levels and parts of a watch selection', () => {
  expect(levelOf({issues: true, pull_requests: true, releases: true})).toBe('all');
  expect(levelOf({issues: false, pull_requests: false, releases: false})).toBe('none');
  expect(levelOf({issues: false, pull_requests: false, releases: true})).toBe('custom');
  expect(watchedParts({issues: true, pull_requests: false, releases: true})).toBe('issues, releases');
});
