// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

async function mount() {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', {headers: {'Content-Type': 'application/json'}}))));
  const me = user(1, 'alice');
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [
    {group: 'user:1', units: [], reason: 'self'}, {group: 'repo:10', units: [], reason: 'owner'},
  ]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('Repository', 'repo:10', repo(10, me, 'notes'));
  s.data.put('Issue', 'repo:10', issue(100, 10, 1, 'Footer links are broken', {poster_id: 2}));
  s.data.put('Issue', 'repo:10', issue(101, 10, 2, 'Faster saves', {poster_id: 1, is_pull: true}));
  s.data.put('Notification', 'user:1', {id: 1, user_id: 1, repo_id: 10, status: 'unread', subject: 'issue', issue_id: 100, comment_id: 0, actor_id: 0, created_at: '', updated_at: ''});
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/']}));
  await router.load();
  render(<App app={app} router={router}/>);
  return s;
}

test('each section follows its own data; with nothing waiting, the welcome replaces the hints', async () => {
  const s = await mount();
  const mine = await screen.findByRole('region', {name: 'Your pull requests'});
  expect(within(mine).getByRole('link', {name: /Faster saves/})).toBeTruthy();
  expect(within(screen.getByRole('region', {name: 'Unread'})).getByRole('link', {name: /Footer links/})).toBeTruthy();
  s.data.put('Issue', 'repo:10', issue(101, 10, 2, 'Faster saves', {poster_id: 1, is_pull: true, state: 'closed'}));
  await waitFor(() => { expect(screen.queryByRole('region', {name: 'Your pull requests'})).toBeNull(); });
  expect(screen.getByRole('region', {name: 'Unread'})).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Open the command menu'})).toBeNull();
  s.data.put('Notification', 'user:1', {id: 1, user_id: 1, repo_id: 10, status: 'read', subject: 'issue', issue_id: 100, comment_id: 0, actor_id: 0, created_at: '', updated_at: ''});
  expect(await screen.findByRole('button', {name: 'Open the command menu'})).toBeTruthy();
});
