// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, user} from '../../test/fakeSession.ts';
import {viewStore} from '../views/views.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); viewStore(1).reload(); });

test('the open view\'s menu words match the sidebar: Rename… and Delete view, with Undo', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', {headers: {'Content-Type': 'application/json'}}))));
  const s = fakeSession({userId: 1});
  s.data.put('User', 'profile:1', user(1, 'alice'));
  const store = viewStore(1);
  store.save('Closed work', '/issues', {state: 'closed'});
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/issues?state=closed']}));
  await router.load();
  render(<App app={app} router={router}/>);
  fireEvent.click(await screen.findByRole('button', {name: 'View “Closed work”'}));
  const menu = await screen.findByRole('menu');
  expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Update the view with these filters', 'Save as a new view…', 'Rename…', 'Delete view']);
  fireEvent.click(within(menu).getByRole('menuitem', {name: 'Delete view'}));
  await waitFor(() => { expect(store.views.map((v) => v.name)).toEqual([]); });
  expect(await screen.findByText('Deleted the view “Closed work”')).toBeTruthy();
  fireEvent.click((await screen.findAllByRole('button', {name: 'Undo'})).at(-1) ?? document.body);
  await waitFor(() => { expect(store.views.map((v) => v.name)).toEqual(['Closed work']); });
});
