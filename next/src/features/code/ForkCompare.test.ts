// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach, expect, test, vi} from 'vitest';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession} from '../../test/fakeSession.ts';
import {forkBranches} from './ForkCompare.tsx';

afterEach(() => { vi.unstubAllGlobals(); });

test('fork branches are grouped by repository, with an explicit repository for same-owner forks', async () => {
  const s = fakeSession();
  s.auth.token = () => Promise.resolve('token');
  const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
  const fetcher = vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('/forks?') ? [
    {id: 21, name: 'renamed', owner: {login: 'alice'}},
    {id: 22, name: 'upstream-copy', owner: {login: 'bob'}},
  ] : [{name: 'fix/footer'}]))));
  vi.stubGlobal('fetch', fetcher);
  expect(await forkBranches(createApp(config, s), 'alice', 'upstream')).toEqual([
    {value: 'alice/renamed:fix/footer', label: 'fix/footer', group: 'alice/renamed', words: 'alice/renamed:fix/footer alice/renamed'},
    {value: 'bob:fix/footer', label: 'fix/footer', group: 'bob/upstream-copy', words: 'bob:fix/footer bob/upstream-copy'},
  ]);
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockClear();
  expect((await forkBranches(createApp(config, s), 'alice', 'upstream', 'BOB')).map((b) => b.value)).toEqual(['bob:fix/footer']);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
