// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {rememberRow} from '../../app/listReturn.ts';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import type {Notification} from '../../protocol/types.gen.ts';
import {classConflicts} from '../../test/conflicts.ts';
import {comment, fakeSession, issue, repo, user} from '../../test/fakeSession.ts';
import {resetServerReasons} from './serverReasons.ts';

const CONFIG = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

let search: {mentioned: number[]; review_requested: number[]};
const fetcher = vi.fn((url: string) => {
  const u = new URL(url, 'http://localhost/');
  let body: unknown = [];
  if (u.pathname === '/api/v1/repos/issues/search') {
    const ids = u.searchParams.get('mentioned') === 'true' ? search.mentioned : u.searchParams.get('review_requested') === 'true' ? search.review_requested : [];
    body = u.searchParams.get('page') === '1' ? ids.map((id) => ({id})) : [];
  }
  return Promise.resolve(new Response(JSON.stringify(body), {status: 200, headers: {'Content-Type': 'application/json'}}));
});

beforeEach(() => {
  search = {mentioned: [], review_requested: []};
  vi.stubGlobal('fetch', fetcher);
  // Isolate queue leadership so tabs from other tests cannot send messages.
  vi.stubGlobal('BroadcastChannel', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetcher.mockReset();
  resetServerReasons();
  localStorage.clear();
});

function note(id: number, issueId: number, at: string, extra: Partial<Notification> = {}): Notification {
  return {id, user_id: 1, repo_id: 20, status: 'unread', subject: 'issue', issue_id: issueId, comment_id: 0, actor_id: 3, created_at: at, updated_at: at, ...extra};
}

function session(statuses: Record<number, string> = {}) {
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [
    {group: 'user:1', units: [], reason: 'self'}, {group: 'repo:20', units: [], reason: 'member'},
  ]}});
  vi.spyOn(s.auth, 'token').mockResolvedValue('token');
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('User', 'org:2', acme);
  s.data.put('User', 'repo:20', {...user(3, 'bob'), full_name: 'Bob Okafor'});
  s.data.put('Repository', 'repo:20', repo(20, acme, 'atlas'));
  const titles = ['Customer asks: can Atlas serve tiles from S3?', 'cache: evict in a loop', 'Follow-up 2', 'Beta feedback batch 2'];
  titles.forEach((title, i) => {
    const at = `2026-10-0${String(9 - i)}T00:00:00Z`;
    s.data.put('Issue', 'repo:20', issue(100 + i, 20, i + 1, title, {poster_id: 3, is_pull: i === 1, updated_at: at}));
    s.data.put('Notification', 'user:1', note(i + 1, 100 + i, at, {...(i === 0 ? {comment_id: 1779} : {}), status: statuses[i + 1] ?? 'unread'}));
  });
  return s;
}

async function renderInbox(path = '/notifications', statuses: Record<number, string> = {}) {
  const s = session(statuses);
  const app = createApp(CONFIG, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  const list = await screen.findByRole('listbox', {name: 'Notifications'});
  return {app, router, list, s};
}

const rowOf = (title: string) => screen.getByRole('option', {name: new RegExp(title.replace(/[?:]/g, '.'))});

test('a row links to the comment it is about, and opening it goes there', async () => {
  const {router} = await renderInbox();
  const row = rowOf('Customer asks');
  expect(row.getAttribute('href')).toBe('/acme/atlas/issues/1#comment-1779');
  expect(rowOf('Follow-up 2').getAttribute('href')).toBe('/acme/atlas/issues/3');
  fireEvent.click(row);
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/acme/atlas/issues/1');
  });
  expect(router.state.location.hash).toBe('comment-1779');
});

test('opening a row reads it once: the issue page it opens does not read it again', async () => {
  const {app, router} = await renderInbox();
  fireEvent.click(rowOf('Follow-up 2'));
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/acme/atlas/issues/3');
  });
  await screen.findByRole('heading', {level: 1, name: /Follow-up 2/});
  const reads = [...editing(app).intents.records.values()].map((r) => r.intent).filter((i) => i.kind === 'notification.status');
  expect(reads).toEqual([expect.objectContaining({notificationId: 3, status: 'read', base: 'unread'})]);
});

test('secondary reason and actor truncate before the notification title', async () => {
  await renderInbox();
  const row = rowOf('Follow-up 2');
  const why = within(row).getByText('· Opened · Bob Okafor');
  expect(why.className).toContain('shrink-4');
  expect(why.className).toContain('truncate');
  expect(why.className).toContain('max-md:max-w-1/4');
  expect(why.title).toBe('· Opened · Bob Okafor');
  const title = within(row).getByText('Follow-up 2').closest('.truncate');
  expect(title?.contains(why)).toBe(false);
  expect(title?.className).not.toContain('shrink-4');
  expect(row.textContent).toContain('acme/atlas #3');
  expect(classConflicts(document.body)).toEqual([]);
});

test('Esc clears the Shift-click anchor: a later Shift-click selects that row alone', async () => {
  const {list} = await renderInbox();
  fireEvent.click(rowOf('Follow-up 2'), {shiftKey: true});
  const bar = await screen.findByRole('toolbar', {name: 'Selected notifications'});
  expect(bar.textContent).toContain('1 selected');
  fireEvent.keyDown(list, {key: 'Escape'});
  expect(screen.queryByRole('toolbar', {name: 'Selected notifications'})).toBeNull();
  fireEvent.click(rowOf('Customer asks'), {shiftKey: true});
  expect(screen.getByRole('toolbar', {name: 'Selected notifications'}).textContent).toContain('1 selected');
  expect(screen.getAllByRole('option', {selected: true}).map((o) => o.textContent)).toEqual([expect.stringContaining('Customer asks')]);
  fireEvent.click(rowOf('Follow-up 2'), {shiftKey: true});
  expect(screen.getByRole('toolbar', {name: 'Selected notifications'}).textContent).toContain('3 selected');
});

test('the selection has visible actions; X works before J', async () => {
  rememberRow('/notifications', 0);
  const {list} = await renderInbox();
  expect(list.getAttribute('aria-activedescendant')).toBeNull();
  act(() => {
    fireEvent.keyDown(document.body, {key: 'x'});
  });
  const bar = await screen.findByRole('toolbar', {name: 'Selected notifications'});
  expect(bar.textContent).toContain('1 selected');
  for (const name of ['Mark as read', 'Mark as unread', 'Pin', 'Unsubscribe']) expect(within(bar).getByRole('button', {name})).toBeTruthy();
  expect(rowOf('Customer asks').textContent).toContain('Unread: ');
  fireEvent.click(within(bar).getByRole('button', {name: 'Mark as read'}));
  await waitFor(() => {
    expect(screen.queryByRole('option', {name: /Customer asks/})).toBeNull();
  });
  expect(screen.queryByRole('toolbar', {name: 'Selected notifications'})).toBeNull();
  fireEvent.click(screen.getAllByRole('button', {name: 'Undo'}).at(-1) ?? document.body);
  await waitFor(() => {
    expect(rowOf('Customer asks').textContent).toContain('Unread: ');
  });
  fireEvent.click(rowOf('Follow-up 2'), {shiftKey: true});
  fireEvent.click(within(screen.getByRole('toolbar', {name: 'Selected notifications'})).getByRole('button', {name: 'Pin'}));
  await waitFor(() => {
    expect(screen.getByText('Pinned')).toBeTruthy();
  });
  expect(rowOf('Follow-up 2').textContent).toContain('Pinned: ');
  fireEvent.click(screen.getByRole('checkbox', {name: 'Clear the selection'}));
  expect(screen.queryByRole('toolbar', {name: 'Selected notifications'})).toBeNull();
});

test('row checkboxes select without opening; the header selects all and clears (a phone)', async () => {
  const {router} = await renderInbox();
  const check = (title: string) => within(rowOf(title).parentElement ?? document.body).getByRole('checkbox', {hidden: true});
  fireEvent.click(check('Follow-up 2'));
  fireEvent.click(check('Beta feedback'));
  expect(router.state.location.pathname).toBe('/notifications');
  expect(screen.getByRole('toolbar', {name: 'Selected notifications'}).textContent).toContain('2 selected');
  expect((screen.getByRole('checkbox', {name: 'Clear the selection'}) as HTMLInputElement).indeterminate).toBe(true);
  fireEvent.click(within(screen.getByRole('toolbar', {name: 'Selected notifications'})).getByRole('button', {name: 'Mark as read'}));
  await waitFor(() => {
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Customer asks'), expect.stringContaining('cache: evict')]);
  });
  fireEvent.click(screen.getByRole('checkbox', {name: 'Select all notifications'}));
  expect(screen.getByRole('toolbar', {name: 'Selected notifications'}).textContent).toContain('2 selected');
  expect(screen.getAllByRole('option', {selected: true})).toHaveLength(2);
  fireEvent.click(screen.getByRole('checkbox', {name: 'Clear the selection'}));
  expect(screen.queryByRole('toolbar', {name: 'Selected notifications'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Select'})).toBeNull();
});

test('the hovered row offers read, pin and its menu', async () => {
  await renderInbox();
  const row = rowOf('Follow-up 2');
  const item = row.parentElement;
  if (!item) throw new Error('no row');
  expect(within(item).queryByRole('button', {name: 'Mark as read', hidden: true})).toBeNull();
  fireEvent.pointerEnter(item, {pointerType: 'mouse'});
  expect(within(item).getByRole('button', {name: /^Mark as read/, hidden: true})).toBeTruthy();
  fireEvent.click(within(item).getByRole('button', {name: /^Pin, to keep it for later/, hidden: true}));
  await waitFor(() => {
    expect(screen.getByText('Pinned')).toBeTruthy();
  });
  expect(within(item).getByRole('button', {name: /^Unpin/, hidden: true})).toBeTruthy();
  fireEvent.click(within(item).getByRole('button', {name: 'More actions', hidden: true}));
  const menu = await screen.findByRole('menu');
  expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
    expect.stringContaining('Open'), expect.stringContaining('Mark as read'), expect.stringContaining('Mark as unread'), expect.stringContaining('Unpin'),
    expect.stringContaining('Unsubscribe'), expect.stringContaining('Unsubscribe and mark read'),
  ]);
  fireEvent.keyDown(menu, {key: 'Escape'});
  await waitFor(() => {
    expect(screen.queryByRole('menu')).toBeNull();
  });
  const done = rowOf('cache: evict').parentElement;
  if (!done) throw new Error('no row');
  fireEvent.pointerEnter(done, {pointerType: 'mouse'});
  fireEvent.click(within(done).getByRole('button', {name: /^Mark as read/, hidden: true}));
  await waitFor(() => {
    expect(screen.queryByRole('option', {name: /cache: evict/})).toBeNull();
  });
  const other = rowOf('Beta feedback').parentElement;
  if (!other) throw new Error('no row');
  fireEvent.pointerEnter(other, {pointerType: 'touch'});
  expect(within(other).queryByRole('button', {name: 'More actions', hidden: true})).toBeNull();
});

test('mentions and review requests come from the server, also for issues never opened here', async () => {
  search = {mentioned: [100, 103], review_requested: [101]};
  const {router} = await renderInbox();
  await waitFor(() => {
    expect(within(rowOf('Customer asks')).getByText(/^· Mentioned(?: ·|$)/)).toBeTruthy();
  });
  expect(within(rowOf('cache: evict')).getByText(/^· Review requested(?: ·|$)/)).toBeTruthy();
  expect(within(rowOf('Beta feedback')).getByText(/^· Mentioned(?: ·|$)/)).toBeTruthy();
  expect(within(rowOf('Follow-up 2')).getByText(/^· Opened(?: ·|$)/)).toBeTruthy();
  const asked = fetcher.mock.calls.map(([url]) => new URL(url, 'http://localhost/')).filter((u) => u.pathname === '/api/v1/repos/issues/search');
  expect(asked.map((u) => u.searchParams.get('state'))).toEqual(['all', 'all']);
  expect(asked.every((u) => u.searchParams.get('since') === '2026-10-06T00:00:00Z')).toBe(true);
  await act(async () => {
    await router.navigate({to: '/notifications', search: {reason: 'mentioned'}});
  });
  await waitFor(() => {
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Customer asks'), expect.stringContaining('Beta feedback')]);
  });
  await act(async () => {
    await router.navigate({to: '/notifications', search: {reason: 'review-requested'}});
  });
  await waitFor(() => {
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('cache: evict')]);
  });
});

test('Reason: Participating lists the threads that mention the viewer or are assigned to them', async () => {
  search = {mentioned: [100, 103], review_requested: []};
  const {router, s} = await renderInbox();
  s.data.put('IssueAssignee', 'repo:20', {id: 1, issue_id: 102, assignee_id: 1});
  s.data.put('IssueAssignee', 'repo:20', {id: 2, issue_id: 101, assignee_id: 3});
  await waitFor(() => {
    expect(within(rowOf('Customer asks')).getByText(/^· Mentioned(?: ·|$)/)).toBeTruthy();
  });
  await act(async () => {
    await router.navigate({to: '/notifications', search: {reason: 'participating'}});
  });
  await waitFor(() => {
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Customer asks'), expect.stringContaining('Follow-up 2'), expect.stringContaining('Beta feedback'),
    ]);
  });
});

test('Reason: Participating includes a review request even without a local timeline', async () => {
  search = {mentioned: [], review_requested: [101]};
  const {router} = await renderInbox();
  await waitFor(() => {
    expect(within(rowOf('cache: evict')).getByText(/^· Review requested(?: ·|$)/)).toBeTruthy();
  });
  await act(async () => {
    await router.navigate({to: '/notifications', search: {reason: 'participating'}});
  });
  await waitFor(() => {
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('cache: evict')]);
  });
});

test('the server\'s answer is remembered on this device: the next visit shows it before asking again', async () => {
  search = {mentioned: [102], review_requested: []};
  await renderInbox();
  await waitFor(() => {
    expect(within(rowOf('Follow-up 2')).getByText(/^· Mentioned(?: ·|$)/)).toBeTruthy();
  });
  cleanup();
  resetServerReasons();
  fetcher.mockImplementation(() => Promise.reject(new TypeError('offline')));
  await renderInbox();
  expect(within(rowOf('Follow-up 2')).getByText(/^· Mentioned(?: ·|$)/)).toBeTruthy();
});

test('by default the inbox is the working view: unread and pinned; "All" and "Unread" are a click away and in the URL', async () => {
  const {router} = await renderInbox('/notifications', {2: 'read', 4: 'pinned'});
  const titles = () => screen.getAllByRole('option').map((o) => /^(?:Unread: |Pinned: )?(.+?)·/.exec(o.textContent)?.[1]);
  expect(titles()).toEqual(['Beta feedback batch 2', 'Customer asks: can Atlas serve tiles from S3?', 'Follow-up 2']);
  fireEvent.click(screen.getByRole('button', {name: 'All'}));
  await waitFor(() => {
    expect(router.state.location.search).toEqual({filter: 'all'});
  });
  expect(titles()).toEqual(['Beta feedback batch 2', 'Customer asks: can Atlas serve tiles from S3?', 'cache: evict in a loop', 'Follow-up 2']);
  fireEvent.click(screen.getByRole('button', {name: /^Unread \(/}));
  await waitFor(() => {
    expect(router.state.location.search).toEqual({filter: 'unread'});
  });
  expect(titles()).toEqual(['Customer asks: can Atlas serve tiles from S3?', 'Follow-up 2']);
  fireEvent.click(screen.getByRole('button', {name: 'Unread and pinned'}));
  await waitFor(() => {
    expect(router.state.location.search).toEqual({});
  });
  expect(titles()).toHaveLength(3);
});

test('deep links keep working: filters with ?filter=all, and an empty working view says where the rest is', async () => {
  await renderInbox('/notifications?filter=all&state=open', {1: 'read', 2: 'read', 3: 'read', 4: 'read'});
  expect(screen.getAllByRole('option')).toHaveLength(4);
  cleanup();
  const app = createApp(CONFIG, session({1: 'read', 2: 'read', 3: 'read', 4: 'read'}));
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/notifications']}));
  await router.load();
  render(<App app={app} router={router}/>);
  expect(await screen.findByText('All caught up')).toBeTruthy();
  expect(screen.getByText('Nothing unread or pinned. Read notifications are under “All”.')).toBeTruthy();
});

test('right-click and Shift+F10 open Primer triage menus and return focus to the list', async () => {
  const {list} = await renderInbox();
  fireEvent.contextMenu(rowOf('Follow-up 2'));
  const menu = await screen.findByRole('menu');
  expect(within(menu).getByRole('menuitem', {name: /^Pin/})).toBeTruthy();
  fireEvent.keyDown(menu, {key: 'Escape'});
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
  await waitFor(() => { expect(document.activeElement).toBe(list); });
  fireEvent.keyDown(list, {key: 'F10', shiftKey: true});
  const keyboardMenu = await screen.findByRole('menu');
  fireEvent.click(within(keyboardMenu).getByRole('menuitem', {name: /^Pin/}));
  await waitFor(() => { expect(rowOf('Follow-up 2').textContent).toContain('Pinned: '); });
});

test('repository filters are searchable Primer panels and grouping is a Group by menu', async () => {
  const {router} = await renderInbox();
  fireEvent.click(screen.getByRole('button', {name: 'Repository'}));
  const input = await screen.findByPlaceholderText('Filter by repository…');
  fireEvent.change(input, {target: {value: 'atlas'}});
  fireEvent.click(await screen.findByRole('option', {name: 'acme/atlas'}));
  await waitFor(() => { expect(router.state.location.search).toMatchObject({repo: '20'}); });
  fireEvent.click(screen.getByRole('button', {name: 'Group by: Date'}));
  expect((await screen.findByRole('menuitemradio', {name: 'Date'})).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(screen.getByRole('menuitemradio', {name: 'Repository'}));
  await waitFor(() => { expect(router.state.location.search).toMatchObject({group: 'repo'}); });
  expect(await screen.findByRole('button', {name: 'Group by: Repository'})).toBeTruthy();
});

test('deltas about issues no notification lists do not recompute the inbox; deltas about listed ones do', async () => {
  const {s} = await renderInbox();
  const measure = vi.spyOn(performance, 'measure');
  const queries = () => measure.mock.calls.filter(([name]) => name === 'inbox:query').length;
  const frame = () => act(() => new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); }));
  s.data.put('Issue', 'repo:20', issue(900, 20, 90, 'Unrelated', {poster_id: 3}));
  s.data.put('Comment', 'issue:900', comment(5000, 900, 'hi'));
  await frame();
  await frame();
  expect(queries()).toBe(0);
  s.data.put('Issue', 'repo:20', issue(102, 20, 3, 'Follow-up 2, renamed', {poster_id: 3, updated_at: '2026-10-07T00:00:00Z'}));
  await waitFor(() => { expect(queries()).toBeGreaterThan(0); });
  expect(rowOf('Follow-up 2, renamed')).toBeTruthy();
});
