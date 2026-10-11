// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterAll, afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, user} from '../../test/fakeSession.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
afterAll(() => new Promise<void>((resolve) => { setTimeout(resolve, 300); }));

test('"Add people" opens with the focus in its search field, so typing a name searches at once (#163)', async () => {
  const me = user(1, 'alice');
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:10', units: [], reason: 'owner'}]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('Repository', 'repo:10', repo(10, me, 'sandbox', {private: true}));
  s.auth.token = () => Promise.resolve('token');
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const path = new URL(url, 'http://localhost').pathname;
    const body = path.endsWith('/users/search') ? {data: [{id: 4, login: 'dan', full_name: 'Dan'}]} : [];
    return Promise.resolve(new Response(JSON.stringify(body), {headers: {'Content-Type': 'application/json'}}));
  }));
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/alice/sandbox/settings/collaboration']}));
  await router.load();
  render(<App app={app} router={router}/>);
  const add = await screen.findByRole('button', {name: 'Add people'});
  await waitFor(() => { expect((add as HTMLButtonElement).disabled).toBe(false); });
  fireEvent.click(add);
  const search = await screen.findByPlaceholderText('Search people…');
  await waitFor(() => { expect(document.activeElement).toBe(search); });
  // The role control is still there, with its default.
  expect(screen.getByRole('radio', {name: 'Write'}).getAttribute('aria-checked')).toBe('true');
  fireEvent.change(document.activeElement as HTMLInputElement, {target: {value: 'dan'}});
  expect(await screen.findByRole('option', {name: /Dan/})).toBeTruthy();
});
