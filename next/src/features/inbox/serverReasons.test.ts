// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {afterEach, expect, test, vi} from 'vitest';
import type {App} from '../../app/store.ts';
import {askServerReasons, FRESH, resetServerReasons, serverReasons} from './serverReasons.ts';

const online = vi.hoisted(() => vi.fn<(app: unknown, req: {path: string}) => Promise<unknown>>());
vi.mock('../../app/api.ts', () => ({online}));

afterEach(() => {
  resetServerReasons();
  online.mockReset();
  vi.useRealTimers();
});

const app = {session: {userId: 1}} as unknown as App;
const settle = () => new Promise((resolve) => {
  setTimeout(resolve, 0);
});

test('asks for every page of mentions and review requests, then not again while the answer is fresh', async () => {
  vi.useFakeTimers({toFake: ['Date']});
  online.mockImplementation((_app, req) => {
    const u = new URL(req.path, 'http://h/api/v1');
    const page = Number(u.searchParams.get('page'));
    if (u.searchParams.get('mentioned') === 'true') return Promise.resolve(page === 1 ? Array.from({length: 50}, (_, i) => ({id: i + 1})) : page === 2 ? [{id: 99}] : []);
    return Promise.resolve(page === 1 ? [{id: 7}] : []);
  });
  askServerReasons(app, () => '2026-01-01T00:00:00Z', true);
  await settle();
  const v = serverReasons(app);
  expect(v?.mentioned.size).toBe(51);
  expect([...v?.reviewRequested ?? []]).toEqual([7]);
  expect(online.mock.calls.map(([, req]) => new URL(req.path, 'http://h/').searchParams.get('page'))).toEqual(['1', '1', '2']);
  expect(online.mock.calls.every(([, req]) => req.path.includes('since=2026-01-01T00%3A00%3A00Z'))).toBe(true);
  online.mockClear();
  askServerReasons(app, () => undefined);
  await settle();
  expect(online).not.toHaveBeenCalled();
  vi.setSystemTime(Date.now() + FRESH + 1);
  askServerReasons(app, () => undefined);
  await settle();
  expect(online).toHaveBeenCalled();
});

test('no answer keeps the last one (offline is not "nothing mentions you")', async () => {
  online.mockResolvedValue([{id: 5}]);
  askServerReasons(app, () => undefined, true);
  await settle();
  expect([...serverReasons(app)?.mentioned ?? []]).toEqual([5]);
  online.mockRejectedValue(new Error('offline'));
  askServerReasons(app, () => undefined, true);
  await settle();
  expect([...serverReasons(app)?.mentioned ?? []]).toEqual([5]);
});
