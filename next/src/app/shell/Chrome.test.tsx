// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {Button} from '@primer/react';
import {ProjectIcon} from '@primer/octicons-react';
import {runInAction} from 'mobx';
import type {ReactElement} from 'react';
import {UnsyncedPanel} from './Unsynced.tsx';
import {createMemoryHistory, createRootRoute, createRouter, RouterProvider} from '@tanstack/react-router';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, user} from '../../test/fakeSession.ts';
import {AppContext, createApp} from '../store.ts';
import {PrimerTheme} from '../App.tsx';
import {notify, dismiss} from '../notices.ts';
import {PageHeader, StackedPageHeader} from './PageHeader.tsx';
import {NoticeViewport} from './NoticeViewport.tsx';
import {Notices} from './Notices.tsx';
import {AccountMenuReal, CreateMenuReal} from './MenusReal.tsx';
import {SidebarSplitter} from './SidebarSplitter.tsx';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

afterEach(() => { vi.useRealTimers(); });

test('Primer page headers keep heading, breadcrumb, controls and live status', () => {
  const session = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: []}});
  const app = createApp(config, session);
  const view = render(<AppContext value={app}><PrimerTheme><PageHeader title="Issues" context={<span>dev / atlas</span>}><Button>New issue</Button></PageHeader></PrimerTheme></AppContext>);
  const title = screen.getByRole('heading', {level: 1, name: 'Issues'});
  expect(title.closest('[data-component="PageHeader"]')).toBeTruthy();
  expect(screen.getByRole('navigation', {name: 'Breadcrumb'}).textContent).toBe('dev / atlas');
  expect(screen.getByRole('status').textContent).toBe('Live');
  expect(screen.getByRole('button', {name: 'New issue'})).toBeTruthy();
  expect(document.title).toBe('Issues · Forgejo');
  act(() => { runInAction(() => { session.data.status.connection = 'offline'; app.ui.pendingIntents = 3; }); });
  expect(screen.getByRole('status').textContent).toBe('Offline');
  const pending = screen.getByRole('button', {name: /Offline · 3 pending: show unsynced changes/});
  fireEvent.click(pending);
  expect(app.ui.unsyncedOpen).toBe(true);
  view.rerender(<AppContext value={app}><PrimerTheme><StackedPageHeader context={<span>dev / atlas</span>} tabs={<nav aria-label="Repository">Code</nav>} title="Commits"><Button>Filter</Button></StackedPageHeader></PrimerTheme></AppContext>);
  const tabs = screen.getByRole('navigation', {name: 'Repository'});
  const commits = screen.getByRole('heading', {level: 1, name: 'Commits'});
  expect(tabs.compareDocumentPosition(commits) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(commits.closest('header') ?? document.body).getByRole('button', {name: 'Filter'})).toBeTruthy();
  // The leading action must opt out of Primer's default narrow-screen hiding: phones need the drawer toggle.
  view.rerender(<AppContext value={app}><PrimerTheme><PageHeader title="Home"/></PrimerTheme></AppContext>);
  const leadingAction = screen.getByRole('button', {name: 'Show the sidebar'}).closest('[data-component="PH_LeadingAction"]');
  expect(leadingAction?.hasAttribute('data-hidden-narrow')).toBe(false);
  expect(leadingAction?.closest('[data-component="TitleArea"]')).toBeNull();
});

test.each([true, false])('a detail page\'s header title is a quiet breadcrumb leaf, still the page\'s h1 (leaf: %s)', (leaf) => {
  const app = createApp(config, fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: []}}));
  render(<AppContext value={app}><PrimerTheme>
    <PageHeader title="Current page" icon={ProjectIcon} context={<span>dev / fzf</span>} leaf={leaf}><Button size="small">Action</Button></PageHeader>
  </PrimerTheme></AppContext>);
  const header = screen.getByText('Current page').closest('header');
  if (!header) throw new Error('Missing page header');
  const heading = within(header).getByRole('heading', {level: 1, name: 'Current page'});
  expect(heading.getAttribute('aria-current')).toBe(leaf ? 'page' : null);
  if (leaf) {
    expect(heading.getAttribute('data-size')).toBe('medium');
    expect(heading.getAttribute('data-weight')).toBe('normal');
    expect(heading.classList.contains('truncate')).toBe(true);
    expect(heading.closest('.header-leaf')).toBeTruthy();
  }
  expect(header.querySelector('svg')?.getAttribute('width')).toBe('16');
  expect(within(header).getByRole('navigation', {name: 'Breadcrumb'}).textContent).toBe('dev / fzf');
  expect(within(header).getByRole('button', {name: 'Action'})).toBeTruthy();
});

test('Banner notices announce, pause while either hovered or focused, and dismiss immediately', () => {
  vi.useFakeTimers();
  const app = createApp(config, undefined);
  const action = vi.fn();
  const id = notify(app, {tone: 'success', title: 'Saved', action: {label: 'Undo', run: action}});
  const view = render(<AppContext value={app}><PrimerTheme><NoticeViewport><Notices/></NoticeViewport></PrimerTheme></AppContext>);
  const region = screen.getByRole('region', {name: 'Saved'});
  expect(region.closest('[aria-live="polite"]')).toBeTruthy();
  const row = region.parentElement ?? region;
  // Banner has responsive copies of its action; jsdom does not evaluate Primer's media-query CSS.
  const undo = within(region).getAllByRole('button', {name: 'Undo'})[0];
  expect(undo).toBeTruthy();
  if (!undo) throw new Error('Missing Undo action');
  fireEvent.pointerEnter(row);
  fireEvent.focus(undo);
  fireEvent.pointerLeave(row);
  act(() => { vi.advanceTimersByTime(20000); });
  expect(screen.getByRole('region', {name: 'Saved'})).toBeTruthy();
  fireEvent.click(undo);
  expect(action).toHaveBeenCalledOnce();
  expect(screen.queryByRole('region', {name: 'Saved'})).toBeNull();
  dismiss(app, id);
  view.unmount();
});

async function renderMenu(menu: ReactElement) {
  const session = fakeSession();
  session.data.put('User', 'profile:1', user(1, 'alice'));
  const app = createApp(config, session);
  const route = createRootRoute({component: () => menu});
  const router = createRouter({routeTree: route, history: createMemoryHistory({initialEntries: ['/']})});
  await router.load();
  render(<AppContext value={app}><PrimerTheme><RouterProvider router={router}/></PrimerTheme></AppContext>);
  return app;
}

const itemNames = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((item) => (item.textContent ?? '').replace(/classic$/, '').trim());

test('the account appearance submenu uses Primer radio menu items', async () => {
  await renderMenu(<AccountMenuReal trigger={<Button>alice</Button>} defaultOpen/>);
  await waitFor(() => { expect(screen.getByRole('menuitem', {name: 'Appearance'})).toBeTruthy(); });
  fireEvent.click(screen.getByRole('menuitem', {name: 'Appearance'}));
  expect(await screen.findByRole('menuitemradio', {name: 'Dark'})).toBeTruthy();
});

test('the account menu follows GitHub: profile items, settings, then the app, and a plain Sign out', async () => {
  await renderMenu(<AccountMenuReal trigger={<Button>alice</Button>} defaultOpen/>);
  const menu = await screen.findByRole('menu');
  expect(itemNames(menu)).toEqual(['Your profile', 'Your repositories', 'Your stars', 'Settings', 'Appearance',
    expect.stringMatching(/^Command menu/), expect.stringMatching(/^Keyboard shortcuts/), 'Open this page in the classic UI', 'Turn off Forgejo Next', 'Sign out']);
  expect(within(menu).getByRole('menuitem', {name: 'Sign out'}).getAttribute('data-variant')).not.toBe('danger');
});

test('the create menu holds what the account menu used to create', async () => {
  const app = await renderMenu(<CreateMenuReal trigger={<Button>Create</Button>} defaultOpen/>);
  const menu = await screen.findByRole('menu');
  expect(itemNames(menu)).toEqual([expect.stringMatching(/^New issue/), 'New repository', 'Import repository', 'New organization']);
  fireEvent.click(within(menu).getByRole('menuitem', {name: /New issue/}));
  expect(app.ui.create).toBeTruthy();
});

test('empty unsynced changes uses a Primer dialog with a working Close action', () => {
  const app = createApp(config, fakeSession());
  runInAction(() => { app.ui.unsyncedOpen = true; });
  render(<AppContext value={app}><PrimerTheme><UnsyncedPanel/></PrimerTheme></AppContext>);
  const dialog = screen.getByRole('dialog', {name: 'Unsynced changes'});
  expect(within(dialog).getByRole('heading', {name: 'Everything is synced'})).toBeTruthy();
  fireEvent.click(within(dialog).getAllByRole('button', {name: 'Close'}).at(-1) ?? dialog);
  expect(app.ui.unsyncedOpen).toBe(false);
});

test('sidebar separator preserves bounded keyboard resizing', () => {
  const resize = vi.fn();
  const commit = vi.fn();
  render(<SidebarSplitter label="Resize the sidebar" value={232} min={180} max={480} onResize={resize} onCommit={commit}/>);
  const separator = screen.getByRole('separator', {name: 'Resize the sidebar'});
  fireEvent.keyDown(separator, {key: 'ArrowRight'});
  expect(commit).toHaveBeenLastCalledWith(248);
  fireEvent.keyDown(separator, {key: 'Home'});
  expect(commit).toHaveBeenLastCalledWith(180);
  fireEvent.keyDown(separator, {key: 'End'});
  expect(commit).toHaveBeenLastCalledWith(480);
});
