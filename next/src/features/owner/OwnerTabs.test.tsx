// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterAll, afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, user} from '../../test/fakeSession.ts';
import {ownerTab} from './OwnerPage.tsx';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
afterAll(() => new Promise<void>((resolve) => { setTimeout(resolve, 300); }));

const repoRow = (id: number, owner: string, name: string, updated: string) => ({id, name, owner: {login: owner}, description: '', private: false, fork: false, archived: false, updated_at: updated});

/** alice (the viewer), acme (an organization she owns); `answer` overrides API v1's answers by path. */
function setup(path: string, answer: (method: string, path: string) => unknown = () => undefined) {
  const s = fakeSession();
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('User', 'org:2', user(2, 'acme', 'organization'));
  s.auth.token = () => Promise.resolve('token');
  const calls: {method: string; path: string}[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://localhost');
    const method = init?.method ?? 'GET';
    calls.push({method, path: `${u.pathname}${u.search}`});
    let value = answer(method, u.pathname);
    if (value === undefined) {
      value = [];
      if (u.pathname.endsWith('/users/alice')) value = {id: 1, login: 'alice', full_name: '', avatar_url: '', description: '', website: '', followers_count: 0, following_count: 0};
      if (u.pathname.endsWith('/users/acme')) value = {id: 2, login: 'acme', full_name: '', avatar_url: '', description: '', website: ''};
      if (u.pathname.endsWith('/permissions')) value = {is_owner: true, is_admin: true, can_create_repository: true};
    }
    return Promise.resolve(new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}}));
  }));
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  return {app, router, calls};
}

test('a tab parameter picks the section the owner has, its first one otherwise', () => {
  expect(ownerTab('stars', false, false)).toBe('stars');
  expect(ownerTab('watching', false, true)).toBe('watching');
  // Only the viewer's own watched repositories.
  expect(ownerTab('watching', false, false)).toBe('overview');
  expect(ownerTab(undefined, false, true)).toBe('overview');
  expect(ownerTab('teams', true, false)).toBe('teams');
  expect(ownerTab('stars', true, false)).toBe('repositories');
});

test('the Stars tab is its own address, most recently starred first, its times labelled (#203, #213)', async () => {
  const {app, router} = setup('/alice?tab=stars', (_m, p) => (p.endsWith('/users/alice/starred') ?
    [repoRow(5, 'acme', 'atlas', '2026-01-02T00:00:00Z'), repoRow(6, 'openlab', 'notes', '2026-01-01T00:00:00Z')] : undefined));
  await router.load();
  render(<App app={app} router={router}/>);
  const panel = await screen.findByRole('region', {name: 'Stars'});
  const tabs = screen.getByRole('navigation', {name: 'Profile sections'});
  const stars = within(tabs).getByRole('link', {name: 'Stars'});
  expect(stars.getAttribute('aria-current')).toBe('page');
  expect(stars.getAttribute('href')).toBe('/alice?tab=stars');
  expect(within(tabs).getByRole('link', {name: 'Overview'}).getAttribute('href')).toBe('/alice');
  expect(within(panel).getByText('Most recently starred first.')).toBeTruthy();
  // Forgejo's order is kept.
  await within(panel).findByText('acme/atlas');
  expect(within(panel).getAllByRole('link').map((a) => a.textContent?.replace(/Updated.*/, ''))).toEqual(['acme/atlas', 'openlab/notes']);
  expect(panel.textContent.match(/Updated /g)).toHaveLength(2);
  // Another tab is another address.
  fireEvent.click(within(tabs).getByRole('link', {name: 'Repositories'}));
  await waitFor(() => { expect(router.state.location.search).toEqual({tab: 'repositories'}); });
  expect(await screen.findByRole('region', {name: 'Repositories'})).toBeTruthy();
});

test('loaded overview sections have one panel border and muted repository separators', async () => {
  const {app, router} = setup('/alice', (_m, p) => {
    if (p.endsWith('/users/alice/heatmap')) return [{timestamp: Math.floor(Date.now() / 1000), contributions: 4}];
    if (p.endsWith('/users/alice/repos')) return [
      {...repoRow(5, 'alice', 'atlas', ''), stars_count: 2},
      {...repoRow(6, 'alice', 'notes', ''), stars_count: 1},
    ];
    return undefined;
  });
  await router.load();
  render(<App app={app} router={router}/>);
  const contributions = await screen.findByRole('region', {name: 'Contributions'});
  await within(contributions).findByRole('img', {name: 'Daily contribution heatmap'});
  const popular = screen.getByRole('region', {name: 'Popular repositories'});
  const first = await within(popular).findByRole('link', {name: /atlas/});
  for (const panel of [contributions, popular]) {
    expect(panel.classList.contains('rounded-md')).toBe(true);
    expect(panel.classList.contains('border')).toBe(true);
    expect(panel.querySelector('.border, .rounded-md')).toBeNull();
    expect(panel.querySelector('header')?.classList.contains('border-b')).toBe(true);
  }
  expect(first.classList.contains('border-muted')).toBe(true);
  expect(within(popular).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/alice/atlas', '/alice/notes']);
});

test('the account menu has "Your stars", which opens the Stars tab (#203)', async () => {
  const {app, router} = setup('/alice');
  await router.load();
  render(<App app={app} router={router}/>);
  fireEvent.click(await screen.findByRole('button', {name: 'alice'}));
  const item = await screen.findByRole('menuitem', {name: 'Your stars'});
  fireEvent.click(item);
  await waitFor(() => { expect(router.state.location.search).toEqual({tab: 'stars'}); });
  expect(router.state.location.pathname).toBe('/alice');
  expect(await screen.findByRole('region', {name: 'Stars'})).toBeTruthy();
});

test('an organization\'s People: every member, removable by an owner; its More menu leads there; teams say their repositories (#199)', async () => {
  let members = [{id: 3, login: 'bob', full_name: 'Bob', avatar_url: ''}, {id: 1, login: 'alice', full_name: '', avatar_url: ''}];
  const {app, router, calls} = setup('/acme', (method, p) => {
    if (p.endsWith('/orgs/acme/members/bob') && method === 'DELETE') {
      members = members.filter((m) => m.login !== 'bob');
      return {};
    }
    if (p.endsWith('/orgs/acme/members')) return members;
    if (p.endsWith('/orgs/acme/teams')) {
      return [{id: 7, name: 'Owners', description: '', permission: 'owner', includes_all_repositories: true},
        {id: 8, name: 'support', description: 'Helps', permission: 'read', includes_all_repositories: false}];
    }
    if (p.endsWith('/teams/8/repos')) return [{id: 5, name: 'atlas', full_name: 'acme/atlas'}, {id: 6, name: 'mobile', full_name: 'acme/mobile'}];
    return undefined;
  });
  await router.load();
  render(<App app={app} router={router}/>);
  fireEvent.click(await screen.findByRole('button', {name: 'More of this organization'}));
  expect((await screen.findByRole('menuitem', {name: /^Members/})).getAttribute('href')).toBe('/org/acme/members');
  fireEvent.click(screen.getByRole('menuitem', {name: 'People'}));
  await waitFor(() => { expect(router.state.location.search).toEqual({tab: 'people'}); });
  const people = await screen.findByRole('region', {name: 'People'});
  fireEvent.click(await within(people).findByRole('button', {name: 'Remove bob from the organization'}));
  const dialog = await screen.findByRole('dialog', {name: 'Remove bob from acme?'});
  fireEvent.click(within(dialog).getByRole('button', {name: 'Remove from organization'}));
  await waitFor(() => { expect(within(people).queryByText('Bob')).toBeNull(); });
  expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/orgs/acme/members/bob')).toBe(true);

  fireEvent.click(within(screen.getByRole('navigation', {name: 'Profile sections'})).getByRole('link', {name: 'Teams'}));
  const teams = await screen.findByRole('region', {name: 'Teams'});
  expect(await within(teams).findByText('All repositories of the organization')).toBeTruthy();
  expect(await within(teams).findByText('2 repositories: atlas, mobile')).toBeTruthy();
});
