// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory, createRootRoute, createRouter, RouterProvider} from '@tanstack/react-router';
import {fireEvent, render, screen, within} from '@testing-library/react';
import type {ReactElement} from 'react';
import {expect, test, vi} from 'vitest';
import {Pager} from './Pager.tsx';

const href = (n: number) => `/acme/atlas/watchers?page=${String(n)}`;

async function show(ui: ReactElement) {
  const router = createRouter({routeTree: createRootRoute({component: () => ui}), history: createMemoryHistory({initialEntries: ['/acme/atlas/watchers']})});
  await router.load();
  const view = render(<RouterProvider router={router}/>);
  return {router, view};
}

const pageLinks = () => within(screen.getByRole('navigation')).queryAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);

test('a known page count: numbered pages, each a real link, the current one marked', async () => {
  await show(<Pager page={2} pageCount={3} href={href}/>);
  const links = pageLinks();
  expect(links).toContainEqual(['1', href(1)]);
  expect(links).toContainEqual(['3', href(3)]);
  expect(within(screen.getByRole('navigation')).getByText('2').closest('[aria-current="page"]')).toBeTruthy();
});

test('an unknown total: Previous and Next only, Next while there is more', async () => {
  await show(<Pager page={2} more href={href}/>);
  const nav = screen.getByRole('navigation');
  expect(within(nav).queryByRole('link', {name: /^Page 1$|^1$/})).toBeNull();
  expect(within(nav).getByRole('link', {name: /Previous/}).getAttribute('href')).toBe(href(1));
  expect(within(nav).getByRole('link', {name: /Next/}).getAttribute('href')).toBe(href(3));
});

test('an unknown total on its last page: Previous, and no Next link', async () => {
  await show(<Pager page={2} href={href}/>);
  const nav = screen.getByRole('navigation');
  expect(within(nav).getByRole('link', {name: /Previous/})).toBeTruthy();
  expect(within(nav).queryByRole('link', {name: /Next/})).toBeNull();
});

test('nothing when everything is on one page', async () => {
  await show(<><Pager page={1} pageCount={1} href={href}/><Pager page={1} href={href}/></>);
  expect(screen.queryByRole('navigation')).toBeNull();
});

test('a plain click navigates in place; a modified one is the browser\'s', async () => {
  const {router} = await show(<Pager page={1} pageCount={3} href={href}/>);
  const two = within(screen.getByRole('navigation')).getByRole('link', {name: /2/});
  fireEvent.click(two, {ctrlKey: true});
  expect(router.state.location.searchStr).toBe('');
  fireEvent.click(two);
  await vi.waitFor(() => { expect(router.state.location.searchStr).toBe('?page=2'); });
});
