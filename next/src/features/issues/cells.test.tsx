// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen} from '@testing-library/react';
import {createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider} from '@tanstack/react-router';
import {expect, test} from 'vitest';
import {AppContext, createApp} from '../../app/store.ts';
import {fakeSession, user} from '../../test/fakeSession.ts';
import {UserAvatar, UserName} from './cells.tsx';

test('owner links on a page below the owner are not marked as the current page', async () => {
  const s = fakeSession();
  s.data.put('User', 'profile:1', user(1, 'alice'));
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, s);
  const root = createRootRoute({component: () => <Outlet/>});
  const people = () => <><UserAvatar id={1} linked/><UserName id={1}/></>;
  const owner = createRoute({getParentRoute: () => root, path: '/$owner', component: people});
  const issue = createRoute({getParentRoute: () => root, path: '/$owner/$repo/issues/$index', component: people});
  const router = createRouter({routeTree: root.addChildren([owner, issue]), history: createMemoryHistory({initialEntries: ['/alice/atlas/issues/1']})});
  await router.load();
  render(<AppContext.Provider value={app}><RouterProvider router={router}/></AppContext.Provider>);
  const avatar = await screen.findByRole('link', {name: 'Profile of alice'});
  expect(avatar.getAttribute('aria-current')).toBeNull();
  expect(screen.getByRole('link', {name: 'alice'}).getAttribute('aria-current')).toBeNull();
  await router.navigate({to: '/$owner', params: {owner: 'alice'}});
  expect((await screen.findByRole('link', {name: 'Profile of alice'})).getAttribute('aria-current')).toBe('page');
});
