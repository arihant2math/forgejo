// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {runInAction} from 'mobx';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {fallbackConfig} from '../../app/config.ts';
import {connectivity} from '../../app/online.ts';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {fakeSession, repo, user} from '../../test/fakeSession.ts';
import {discover} from './discovery.ts';
import type * as DiscoveryModule from './discovery.ts';

vi.mock('./discovery.ts', async (original) => ({...await original<typeof DiscoveryModule>(), discover: vi.fn()}));
afterEach(() => { runInAction(() => { connectivity.online = true; }); vi.clearAllMocks(); });

async function mount() {
  const session = fakeSession();
  const owner = user(1, 'alice');
  session.data.put('User', 'profile:1', owner);
  session.data.put('Repository', 'repo:10', repo(10, owner, 'one'));
  session.data.put('Repository', 'repo:20', repo(20, owner, 'two'));
  const app = createApp(fallbackConfig(), session);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/search']}));
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

test('server results outside the pool are visible and the next page is reflected in the URL', async () => {
  vi.mocked(discover).mockResolvedValue({rows: [{id: 999, title: 'outside/project', detail: '', path: '/outside/project'}], total: 75});
  const router = await mount();
  await screen.findByRole('option', {name: 'outside/project'});
  fireEvent.click(screen.getByRole('button', {name: 'Next'}));
  await waitFor(() => { expect(router.state.location.search).toMatchObject({page: '2'}); });
  await waitFor(() => { expect(vi.mocked(discover).mock.calls.some((call) => call[1].page === 2)).toBe(true); });
});
