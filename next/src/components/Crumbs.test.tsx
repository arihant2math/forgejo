// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory, createRootRoute, createRouter, RouterProvider} from '@tanstack/react-router';
import {fireEvent, render, screen, within} from '@testing-library/react';
import type {ReactElement} from 'react';
import {afterEach, expect, test, vi} from 'vitest';
import {type Crumb, Crumbs} from './Crumbs.tsx';

afterEach(() => { vi.restoreAllMocks(); });

async function at(path: string, ui: ReactElement) {
  const router = createRouter({routeTree: createRootRoute({component: () => ui}), history: createMemoryHistory({initialEntries: [path]})});
  await router.load();
  render(<RouterProvider router={router}/>);
  return {router, nav: await screen.findByRole('navigation', {name: 'Breadcrumbs'})};
}

const repoCrumbs: Crumb[] = [
  {label: 'acme', link: {to: '/$owner', params: {owner: 'acme'}}},
  {label: 'atlas', link: {to: '/$owner/$repo', params: {owner: 'acme', repo: 'atlas'}}},
];

test('a list of router links; only the crumb of this very page is current', async () => {
  const {nav} = await at('/acme/atlas', <Crumbs crumbs={repoCrumbs}/>);
  const items = within(nav).getAllByRole('listitem');
  expect(items.map((li) => li.textContent)).toEqual(['acme', 'atlas']);
  expect(nav.querySelector('ol')?.children.length).toBe(2);
  const acme = within(nav).getByRole('link', {name: 'acme'});
  expect(acme.getAttribute('href')).toBe('/acme');
  expect(acme.hasAttribute('aria-current')).toBe(false);
  expect(within(nav).getByRole('link', {name: 'atlas'}).getAttribute('aria-current')).toBe('page');
});

test('a crumb without a destination is the current page, as text', async () => {
  const {nav} = await at('/acme/atlas/issues/1', <Crumbs crumbs={[...repoCrumbs, {label: 'Issue 1'}]}/>);
  expect(within(nav).getAllByRole('link', {current: false}).map((a) => a.textContent)).toEqual(['acme', 'atlas']);
  const leaf = within(nav).getByText('Issue 1');
  expect(leaf.tagName).toBe('SPAN');
  expect(leaf.getAttribute('aria-current')).toBe('page');
});

test('a router link navigates in place', async () => {
  const {router, nav} = await at('/acme/atlas/issues', <Crumbs crumbs={repoCrumbs}/>);
  fireEvent.click(within(nav).getByRole('link', {name: 'atlas'}));
  await vi.waitFor(() => { expect(router.state.location.pathname).toBe('/acme/atlas'); });
});

test('a deep trail keeps its root and last crumbs and folds the middle into a menu of router links', async () => {
  // jsdom has no layout: give the trail a wide container and each crumb a width.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.tagName === 'NAV' ? 1000 : 40;
  });
  const dirs = ['src', 'app', 'shell', 'deep'];
  const crumbs: Crumb[] = [
    {label: 'Code', link: {to: '/$owner/$repo', params: {owner: 'acme', repo: 'atlas'}}},
    ...dirs.map((d, i): Crumb => ({label: d, link: {to: '/$owner/$repo/$view/$', params: {owner: 'acme', repo: 'atlas', view: 'src', _splat: `branch/main/${dirs.slice(0, i + 1).join('/')}`}}})),
    {label: 'file.ts'},
  ];
  const {nav} = await at('/acme/atlas/src/branch/main/src/app/shell/deep/file.ts', <Crumbs crumbs={crumbs} overflow="menu-with-root"/>);
  const more = await within(nav).findByRole('button', {name: /more breadcrumb items/});
  const trail = [...nav.querySelector('ol')?.children ?? []];
  const visible = trail.filter((li) => !li.contains(more)).map((li) => li.textContent);
  expect(visible).toEqual(['Code', 'shell', 'deep', 'file.ts']);
  expect(trail[1]?.contains(more)).toBe(true);
  fireEvent.click(more);
  const folded = within(nav).getByRole('link', {name: 'src'});
  expect(folded.getAttribute('href')).toBe('/acme/atlas/src/branch/main/src');
});
