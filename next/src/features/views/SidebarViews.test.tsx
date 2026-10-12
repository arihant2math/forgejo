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
import {viewStore} from './views.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); viewStore(1).reload(); });

async function mount(path: string) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', {headers: {'Content-Type': 'application/json'}}))));
  const s = fakeSession({userId: 1});
  s.data.put('User', 'profile:1', user(1, 'alice'));
  const store = viewStore(1);
  store.save('Everything', '/notifications', {filter: 'all'});
  store.save('Unread', '/notifications', {filter: 'unread'});
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return within(await screen.findByRole('navigation', {name: 'Saved views'}));
}

test('the open view is current whatever the order or empty values of its query', async () => {
  const views = await mount('/notifications?reason=&filter=all');
  expect(views.getByRole('link', {name: 'Everything'}).getAttribute('aria-current')).toBe('page');
  expect(views.getByRole('link', {name: 'Unread'}).getAttribute('aria-current')).not.toBe('page');
});

test('a visible row button opens the view\'s menu; deleting offers Undo', async () => {
  const views = await mount('/notifications?filter=all');
  fireEvent.click(views.getByRole('button', {name: 'Options for the view Everything'}));
  const menu = await screen.findByRole('menu');
  expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Rename…', 'Delete view']);
  fireEvent.click(within(menu).getByRole('menuitem', {name: 'Delete view'}));
  await waitFor(() => { expect(views.queryByRole('link', {name: 'Everything'})).toBeNull(); });
  fireEvent.click((await screen.findAllByRole('button', {name: 'Undo'})).at(-1) ?? document.body);
  await waitFor(() => { expect(views.getAllByRole('link').map((l) => l.textContent)).toEqual(['Everything', 'Unread']); });
  expect(views.getByRole('link', {name: 'Everything'}).getAttribute('aria-current')).toBe('page');
});
