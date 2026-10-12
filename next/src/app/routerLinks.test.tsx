// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory, createRootRoute, createRouter, RouterProvider} from '@tanstack/react-router';
import {fireEvent, render, screen} from '@testing-library/react';
import {expect, test, vi} from 'vitest';
import {classConflicts} from '../test/conflicts.ts';
import {PrimaryAnchor, PrimaryLink, RouterLink} from './routerLinks.tsx';

const LOOK = ['text-default', 'hover:text-accent', 'hover:underline'];

test('PrimaryLink: a router link with GitHub\'s Link--primary look and the caller\'s layout', async () => {
  const router = createRouter({
    routeTree: createRootRoute({component: () => <>
      <PrimaryLink to="/$owner" params={{owner: 'acme'}} className="min-w-0 truncate">acme</PrimaryLink>
      <RouterLink to="/$owner" params={{owner: 'dev'}} muted>dev</RouterLink>
    </>}),
    history: createMemoryHistory({initialEntries: ['/']}),
  });
  await router.load();
  const {container} = render(<RouterProvider router={router}/>);
  const link = await screen.findByRole('link', {name: 'acme'});
  expect(link.getAttribute('href')).toBe('/acme');
  expect([...link.classList]).toEqual(expect.arrayContaining([...LOOK, 'min-w-0', 'truncate']));
  expect(screen.getByRole('link', {name: 'dev'}).getAttribute('data-muted')).toBe('true');
  expect(classConflicts(container)).toEqual([]);
  fireEvent.click(link);
  await vi.waitFor(() => { expect(router.state.location.pathname).toBe('/acme'); });
});

test('PrimaryAnchor: the same look on a plain anchor', () => {
  render(<PrimaryAnchor href="https://example.com/" className="truncate">example</PrimaryAnchor>);
  const a = screen.getByRole('link', {name: 'example'});
  expect(a.getAttribute('href')).toBe('https://example.com/');
  expect([...a.classList]).toEqual(expect.arrayContaining([...LOOK, 'truncate']));
});
