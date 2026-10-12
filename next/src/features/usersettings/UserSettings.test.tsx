// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {runInAction} from 'mobx';
import {afterAll, afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {connectivity} from '../../app/online.ts';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {setThemePreference, themeState} from '../../app/theme.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, user} from '../../test/fakeSession.ts';
import type {UserSettings} from './payload.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
const settings: UserSettings = {
  full_name: 'Alice', website: '', description: '', location: '', pronouns: '', language: 'en-US', theme: 'forgejo-auto', diff_view_style: '',
  enable_repo_unit_hints: true, hide_email: false, hide_pronouns: false, hide_activity: false,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  runInAction(() => { connectivity.online = true; });
  setThemePreference('system');
  localStorage.clear();
});
afterAll(() => new Promise<void>((resolve) => { setTimeout(resolve, 300); }));

async function open(path: string) {
  const s = fakeSession();
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.auth.token = () => Promise.resolve('token');
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
}

test('local theme remains available offline and Settings uses navigable current links', async () => {
  const fetch = vi.fn(() => Promise.resolve(new Response('{}', {status: 404})));
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  runInAction(() => { connectivity.online = false; });
  await open('/user/settings/appearance');
  const nav = screen.getByRole('navigation', {name: 'Settings pages'});
  expect(within(nav).getByRole('link', {name: 'Appearance'}).getAttribute('aria-current')).toBe('page');
  expect(screen.getByText('Changing account settings needs a connection: it is not queued offline.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Dark'}));
  expect(themeState.preference).toBe('dark');
  expect(screen.getByRole('button', {name: 'Dark'}).getAttribute('aria-pressed')).toBe('true');
  expect(fetch).not.toHaveBeenCalled();
});

test('privacy uses a named Primer toggle and restores its state after a refused write', async () => {
  const patches: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
    const patch = init?.method === 'PATCH';
    if (patch && typeof init.body === 'string') patches.push(JSON.parse(init.body) as unknown);
    return Promise.resolve(new Response(JSON.stringify(patch ? {message: 'No changes allowed'} : settings), {status: patch ? 422 : 200, headers: {'Content-Type': 'application/json'}}));
  }));
  await open('/user/settings');
  const toggle = await screen.findByRole('button', {name: 'Hide my email address'});
  act(() => { fireEvent.click(toggle); });
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  await waitFor(() => { expect(toggle.getAttribute('aria-pressed')).toBe('false'); });
  expect(patches).toEqual([{hide_email: true}]);
  expect(await screen.findByText('Hide my email address: not saved')).toBeTruthy();
});

test('GitHub\'s header names whose settings these are; deleting the account is a danger-zone button', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', {status: 200, headers: {'Content-Type': 'application/json'}}))));
  await open('/user/settings/account');
  expect(screen.getByText('Your personal account')).toBeTruthy();
  expect(screen.getByRole('link', {name: 'Go to your personal profile'}).getAttribute('href')).toBe('/alice');
  const nav = screen.getByRole('navigation', {name: 'Settings pages'});
  expect(within(nav).getAllByRole('link').slice(0, 4).map((a) => a.textContent)).toEqual(['Public profile', 'Account', 'Appearance', 'SSH and GPG keys']);
  const zone = screen.getByRole('region', {name: 'Delete account'});
  expect(within(zone).queryByRole('alert')).toBeNull();
  expect(within(zone).getByRole('link', {name: /^Delete your account/}).getAttribute('data-variant')).toBe('danger');
});
