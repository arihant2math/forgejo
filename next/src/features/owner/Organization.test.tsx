// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterAll, afterEach, expect, onTestFinished, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, user} from '../../test/fakeSession.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
afterAll(() => new Promise<void>((resolve) => { setTimeout(resolve, 300); }));

test('organization management loads on open, writes organization labels and team members through v1', async () => {
  const s = fakeSession();
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('User', 'org:2', user(2, 'acme', 'organization'));
  s.auth.token = () => Promise.resolve('token');
  const calls: {method: string; path: string; body: unknown}[] = [];
  let created = false;
  let member = false;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({method, path, body});
    let value: unknown = [];
    if (path.endsWith('/users/acme')) value = {id: 2, login: 'acme', full_name: '', avatar_url: '', description: '', website: ''};
    if (path.endsWith('/permissions')) value = {is_owner: true, is_admin: true};
    if (path.endsWith('/orgs/acme/teams')) value = [{id: 7, name: 'triage', description: '', permission: 'read'}];
    if (path.endsWith('/orgs/acme/labels')) {
      if (method === 'POST') created = true;
      value = created ? [{id: 9, name: 'priority', color: 'abcdef', description: '', exclusive: false, is_archived: false}] : [];
    }
    if (path.endsWith('/teams/7/members/bob')) member = method === 'PUT';
    if (path.endsWith('/teams/7/members')) value = member ? [{id: 3, login: 'bob', full_name: '', avatar_url: ''}] : [];
    if (path.endsWith('/users/search')) value = {data: [{id: 3, login: 'bob'}]};
    return Promise.resolve(new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}}));
  }));
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/acme']}));
  await router.load();
  render(<App app={app} router={router}/>);
  await screen.findByRole('button', {name: 'Labels'});
  expect(calls.some((c) => c.path.endsWith('/orgs/acme/teams'))).toBe(false);
  fireEvent.click(screen.getByRole('button', {name: 'Labels'}));
  fireEvent.click(await screen.findByRole('button', {name: 'New organization label'}));
  fireEvent.change(screen.getByRole('textbox', {name: 'Name'}), {target: {value: 'priority'}});
  fireEvent.click(screen.getByRole('button', {name: 'Create label'}));
  await screen.findByText('priority', {exact: true});
  expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/orgs/acme/labels'))?.body).toMatchObject({name: 'priority', exclusive: false, is_archived: false});
  fireEvent.click(screen.getByRole('link', {name: 'Teams'}));
  fireEvent.click(await screen.findByRole('button', {name: 'Members of triage'}));
  // Primer's virtualized picker needs a viewport size; jsdom has no layout.
  const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(320);
  const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(640);
  onTestFinished(() => { height.mockRestore(); width.mockRestore(); });
  fireEvent.click(await screen.findByRole('button', {name: 'Add member'}));
  fireEvent.change(screen.getByRole('combobox'), {target: {value: 'bob'}});
  fireEvent.click(await screen.findByRole('option', {name: /bob/}));
  await screen.findByRole('button', {name: 'Remove bob from team'});
  expect(calls.some((c) => c.method === 'PUT' && c.path.endsWith('/teams/7/members/bob'))).toBe(true);
  fireEvent.click(screen.getByRole('button', {name: 'Remove bob from team'}));
  await waitFor(() => { expect(screen.queryByRole('button', {name: 'Remove bob from team'})).toBeNull(); });
  expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/teams/7/members/bob'))).toBe(true);
});
