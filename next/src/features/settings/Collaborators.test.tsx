// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterAll, afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, user} from '../../test/fakeSession.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
afterAll(() => new Promise<void>((resolve) => { setTimeout(resolve, 300); }));

test('"Add people" opens with the focus in its search field, so typing a name searches at once; then a role is chosen', async () => {
  const me = user(1, 'alice');
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:10', units: [], reason: 'owner'}]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('Repository', 'repo:10', repo(10, me, 'sandbox', {private: true}));
  s.auth.token = () => Promise.resolve('token');
  const writes: {url: string; method: string; body?: unknown}[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes.push({url, method: init.method, ...(typeof init.body === 'string' ? {body: JSON.parse(init.body) as unknown} : {})});
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
  fireEvent.change(document.activeElement as HTMLInputElement, {target: {value: 'dan'}});
  const panel = screen.getByRole('dialog', {name: 'Add a collaborator'});
  const person = await within(panel).findByRole('option', {name: /Dan/});
  fireEvent.click(person);
  const confirm = await screen.findByRole('dialog', {name: 'Add dan to sandbox'});
  expect(within(confirm).getByRole<HTMLInputElement>('radio', {name: 'Write'}).checked).toBe(true);
  expect(within(confirm).getByText(/delete it/)).toBeTruthy();
  fireEvent.click(within(confirm).getByRole('radio', {name: 'Read'}));
  expect(writes.some((write) => write.method === 'PUT')).toBe(false);
  fireEvent.click(within(confirm).getByRole('button', {name: 'Add dan to this repository'}));
  await waitFor(() => { expect(writes).toContainEqual({url: '/api/v1/repos/alice/sandbox/collaborators/dan', method: 'PUT', body: {permission: 'read'}}); });
  await waitFor(() => { expect(document.activeElement).toBe(add); });
  fireEvent.click(screen.getByRole('button', {name: 'Remove dan'}));
  expect(screen.getByRole('alertdialog', {name: 'Remove dan?'})).toBeTruthy();
  expect(writes.some((write) => write.method === 'DELETE')).toBe(false);
  fireEvent.click(screen.getByRole('button', {name: 'Remove collaborator'}));
  await waitFor(() => { expect(writes.map(({url, method}) => ({url, method}))).toContainEqual({url: '/api/v1/repos/alice/sandbox/collaborators/dan', method: 'DELETE'}); });
});
