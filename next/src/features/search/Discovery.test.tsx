// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {runInAction} from 'mobx';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {fallbackConfig} from '../../app/config.ts';
import {connectivity} from '../../app/online.ts';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {fakeSession, repo, user} from '../../test/fakeSession.ts';
import {discover, localDiscovery} from './discovery.ts';
import type * as DiscoveryModule from './discovery.ts';

vi.mock('./discovery.ts', async (original) => {
  const actual = await original<typeof DiscoveryModule>();
  return {...actual, discover: vi.fn(), localDiscovery: vi.fn(actual.localDiscovery)};
});
afterEach(() => { runInAction(() => { connectivity.online = true; }); vi.clearAllMocks(); });

async function mount(path = '/search') {
  const session = fakeSession();
  const owner = user(1, 'alice');
  session.data.put('User', 'profile:1', owner);
  session.data.put('Repository', 'repo:10', repo(10, owner, 'one'));
  session.data.put('Repository', 'repo:20', repo(20, owner, 'two'));
  const app = createApp(fallbackConfig(), session);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return router;
}

test('offline search uses the pool and supports the list keyboard cursor without contacting the server', async () => {
  runInAction(() => { connectivity.online = false; });
  await mount();
  await screen.findByRole('note');
  const list = screen.getByRole('listbox', {name: 'Search results'});
  await screen.findByRole('option', {name: 'alice/one'});
  fireEvent.keyDown(list, {key: 'j'});
  expect(screen.getByRole('option', {name: 'alice/two'}).getAttribute('data-active')).toBe('');
  fireEvent.keyDown(list, {key: 'k'});
  expect(screen.getByRole('option', {name: 'alice/one'}).getAttribute('data-active')).toBe('');
  expect(discover).not.toHaveBeenCalled();
});

test('offline, moving the cursor does not scan the pool again', async () => {
  runInAction(() => { connectivity.online = false; });
  await mount();
  const list = screen.getByRole('listbox', {name: 'Search results'});
  await screen.findByRole('option', {name: 'alice/one'});
  const scans = vi.mocked(localDiscovery).mock.calls.length;
  for (let i = 0; i < 4; i++) fireEvent.keyDown(list, {key: i % 2 ? 'k' : 'j'});
  expect(vi.mocked(localDiscovery).mock.calls.length).toBe(scans);
});

test('result types are links in GitHub\'s order, Code first, each with its own address', async () => {
  vi.mocked(discover).mockResolvedValue({rows: [], total: 3});
  await mount('/search?q=atlas');
  const nav = screen.getByRole('navigation', {name: 'Search type'});
  const links = within(nav).getAllByRole('link');
  expect(links.map((a) => a.textContent.replace(/[\d…()\s]+$/, ''))).toEqual(['Code', 'Repositories', 'Issues', 'Pull requests', 'Users', 'Organizations']);
  expect(links[1]?.getAttribute('aria-current')).toBe('page');
  expect(links[0]?.getAttribute('href')).toMatch(/\/search\?q=atlas&type=code$/);
  expect(links[2]?.getAttribute('href')).toMatch(/\/search\?q=atlas&type=issues&sort=updated&state=all&page=1$/);
});

test('issue results lead with their state, not a word in the detail', async () => {
  vi.mocked(discover).mockResolvedValue({rows: [{id: 7, title: 'Tiles flicker', detail: 'acme/atlas #4', path: '/acme/atlas/pulls/4', state: 'closed', merged: true}], total: 1});
  await mount('/search?type=pulls');
  const row = await screen.findByRole('option', {name: /Tiles flicker/});
  expect(within(row).getByLabelText('Merged')).toBeTruthy();
  expect(row.textContent).not.toContain('closed');
});

test('typing a filter replaces the history entry instead of adding one per keystroke', async () => {
  vi.mocked(discover).mockResolvedValue({rows: [], total: 0});
  const router = await mount();
  const before = router.history.length;
  expect(before).toBeGreaterThan(0);
  const language = screen.getByRole('textbox', {name: 'Primary language'});
  fireEvent.change(language, {target: {value: 'g'}});
  fireEvent.change(language, {target: {value: 'go'}});
  await waitFor(() => { expect(router.state.location.search).toMatchObject({language: 'go'}); });
  fireEvent.change(screen.getByRole('textbox', {name: 'Search across Forgejo'}), {target: {value: 'atlas'}});
  await waitFor(() => { expect(router.state.location.search).toMatchObject({q: 'atlas', language: 'go'}); });
  expect(router.history.length).toBe(before);
});

test('server results outside the pool are visible and the next page is reflected in the URL', async () => {
  vi.mocked(discover).mockResolvedValue({rows: [{id: 999, title: 'outside/project', detail: '', path: '/outside/project'}], total: 75});
  const router = await mount();
  await screen.findByRole('option', {name: 'outside/project'});
  const pager = screen.getByRole('navigation', {name: 'Pagination'});
  expect(within(pager).getByRole('link', {name: 'Page 2'}).getAttribute('href')).toMatch(/\/search\?type=repositories&sort=updated&state=all&page=2$/);
  fireEvent.click(within(pager).getByRole('link', {name: 'Next Page'}));
  await waitFor(() => { expect(router.state.location.search).toMatchObject({page: '2'}); });
  await waitFor(() => { expect(vi.mocked(discover).mock.calls.some((call) => call[1].page === 2)).toBe(true); });
});

test('result rows are links whose hover underlines the name only, not the whole row (#286)', async () => {
  runInAction(() => { connectivity.online = false; });
  await mount();
  const row = await screen.findByRole('option', {name: 'alice/one'});
  // Primer's BaseStyles underline every unclassed a:hover: the row opts out, its name opts in (group-hover).
  expect(row.tagName).toBe('A');
  expect(row.classList).toContain('no-underline');
  expect(row.classList).not.toContain('hover:underline');
  const [icon, name] = [...row.children];
  expect(icon?.querySelector('svg')).not.toBeNull();
  expect(name?.textContent).toBe('alice/one');
  expect(name?.classList).toContain('group-hover:underline');
  expect(name?.classList).toContain('group-hover:text-accent');
});
