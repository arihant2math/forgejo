// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {act, fireEvent, render, screen} from '@testing-library/react';
import {createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider} from '@tanstack/react-router';
import {afterEach, expect, test, vi} from 'vitest';
import {ListRow, ListRowLink} from '../components/ListRow.tsx';
import {useSiteLink} from './links.ts';

afterEach(() => { vi.useRealTimers(); });

function Rows() {
  const link = useSiteLink();
  return <>
    <ListRow {...link('/notifications?x=1')}>by site path</ListRow>
    <ListRowLink to="/notifications">typed</ListRowLink>
  </>;
}

async function setup() {
  const loader = vi.fn((_match: unknown) => null);
  const root = createRootRoute({component: () => <Outlet/>});
  const home = createRoute({getParentRoute: () => root, path: '/', component: Rows});
  const target = createRoute({getParentRoute: () => root, path: '/notifications', loader, component: () => <p>Target</p>});
  const router = createRouter({routeTree: root.addChildren([home, target]), history: createMemoryHistory(), defaultPreload: 'intent', defaultPreloadDelay: 50});
  await router.load();
  render(<RouterProvider router={router}/>);
  await screen.findByText('typed');
  return {router, loader};
}

test('a site-path row preloads its destination once the pointer settles, not when it passes over', async () => {
  const {loader} = await setup();
  const row = screen.getByRole('link', {name: 'by site path'});
  vi.useFakeTimers();
  fireEvent.pointerEnter(row);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  fireEvent.pointerLeave(row);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(loader).not.toHaveBeenCalled();
  fireEvent.pointerEnter(row);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(loader).toHaveBeenCalledTimes(1);
  expect(loader.mock.calls[0]?.[0]).toMatchObject({preload: true, location: {pathname: '/notifications', search: {x: 1}}});
});

test('focus preloads too, and a plain click navigates in place', async () => {
  const {router, loader} = await setup();
  const row = screen.getByRole('link', {name: 'by site path'});
  vi.useFakeTimers();
  fireEvent.focus(row);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(loader).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
  fireEvent.click(row);
  expect(await screen.findByText('Target')).toBeTruthy();
  expect(router.state.location.pathname).toBe('/notifications');
});

test('focus that moves on before the delay does not preload', async () => {
  const {loader} = await setup();
  const row = screen.getByRole('link', {name: 'by site path'});
  vi.useFakeTimers();
  fireEvent.focus(row);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  fireEvent.blur(row);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(loader).not.toHaveBeenCalled();
});

test('a typed row is a router link with intent preloading', async () => {
  const {loader} = await setup();
  const row = screen.getByRole('link', {name: 'typed'});
  expect(row.getAttribute('href')).toBe('/notifications');
  vi.useFakeTimers();
  fireEvent.mouseEnter(row);
  await act(async () => { await vi.advanceTimersByTimeAsync(60); });
  expect(loader).toHaveBeenCalledTimes(1);
});
