// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ThemeProvider} from '@primer/react';
import type * as RouterApi from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {afterEach, expect, test, vi} from 'vitest';
import type {PullRequest} from '../../protocol/types.gen.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';
import {discoverySearch} from '../../features/search/params.ts';
import {connectivity} from '../online.ts';
import {AppContext, createApp, type App} from '../store.ts';
import {shortcuts} from '../shortcuts/index.ts';
import {Palette} from './Palette.tsx';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', async (original) => ({
  ...await original<typeof RouterApi>(),
  useNavigate: () => navigate,
  useRouterState: () => '/',
}));

const server = vi.hoisted(() => ({
  searchServer: vi.fn(() => Promise.resolve([])),
  searchServerRepos: vi.fn(() => Promise.resolve([])),
  searchServerUsers: vi.fn(() => Promise.resolve([])),
  searchServerOrgs: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../features/search/server.ts', async (original) => ({...await original<object>(), ...server}));

const Harness = observer(({app}: {app: App}) => (app.ui.paletteOpen ? <Palette/> : null));
function setup() {
  const session = fakeSession();
  const owner = user(2, 'acme');
  session.data.put('User', 'org:2', owner);
  session.data.put('Repository', 'repo:20', repo(20, owner, 'website'));
  session.data.put('Issue', 'repo:20', issue(100, 20, 7, 'Footer links are broken'));
  const app = createApp({
    app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null,
  }, session);
  render(<ThemeProvider><AppContext.Provider value={app}><button type="button">Opener</button><Harness app={app}/></AppContext.Provider></ThemeProvider>);
  const opener = screen.getByRole('button', {name: 'Opener'});
  opener.focus();
  act(() => { runInAction(() => { app.ui.paletteOpen = true; }); });
  return {app, opener, session};
}
const input = () => screen.getByRole('combobox', {name: 'Command menu'});
const cursor = () => {
  const id = input().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};
async function type(query: string, expected: string) {
  fireEvent.change(input(), {target: {value: query}});
  await waitFor(() => { expect(cursor()?.textContent).toContain(expected); });
}

afterEach(() => {
  navigate.mockClear();
  for (const fn of Object.values(server)) fn.mockClear();
  runInAction(() => { connectivity.online = true; });
});

test('Primer dialog focuses its combobox; Escape returns focus and reopening clears the query', async () => {
  const {app, opener} = setup();
  expect(screen.getByRole('dialog', {name: 'Command menu'})).toBeTruthy();
  await waitFor(() => { expect(document.activeElement).toBe(input()); });
  await type('footer', 'Footer links are broken');
  fireEvent.keyDown(input(), {key: 'Escape'});
  await waitFor(() => { expect(document.activeElement).toBe(opener); });
  expect(app.ui.paletteOpen).toBe(false);
  expect(screen.queryByRole('dialog')).toBeNull();
  act(() => { runInAction(() => { app.ui.paletteOpen = true; }); });
  expect((input() as HTMLInputElement).value).toBe('');
  await waitFor(() => { expect(document.activeElement).toBe(input()); });
});

test('typing searches the pool; Enter opens the exact reference without restoring trigger focus', async () => {
  const {app, opener} = setup();
  await type('website#7', 'Footer links are broken');
  expect(cursor()?.getAttribute('aria-selected')).toBe('true');
  expect(cursor()?.textContent).toContain('acme/website#7');
  fireEvent.keyDown(input(), {key: 'Enter'});
  expect(navigate).toHaveBeenCalledWith({to: '/$owner/$repo/issues/$index', params: {owner: 'acme', repo: 'website', index: '7'}});
  expect(app.ui.paletteOpen).toBe(false);
  expect(document.activeElement).not.toBe(opener);
});

test('aliases and shortcut sequences keep their ranking; a partial destructive name has no default', async () => {
  const {app} = setup();
  await type('new issue', 'Create an issue');
  await type('g i', 'Go to my issues');
  await type('?', 'Keyboard shortcuts');
  fireEvent.change(input(), {target: {value: 'sign'}});
  await screen.findByRole('option', {name: /Sign out/});
  await waitFor(() => { expect(cursor()).toBeNull(); });
  fireEvent.keyDown(input(), {key: 'Enter'});
  expect(app.ui.paletteOpen).toBe(true);
  fireEvent.keyDown(input(), {key: 'ArrowDown'});
  expect(cursor()?.textContent).toContain('Sign out');
  await type('sign out', 'Sign out');
});

test('unavailable commands explain why and keep the palette open', async () => {
  const {app} = setup();
  await type('go to the code', 'Go to the code');
  expect(cursor()?.textContent).toContain('Open a repository first');
  fireEvent.keyDown(input(), {key: 'Enter'});
  expect(app.ui.paletteOpen).toBe(true);
  expect(app.ui.notices.at(-1)?.title).toContain('Open a repository first');
});

test('a seeded query is taken once and offline pool results remain usable', async () => {
  const {app} = setup();
  fireEvent.keyDown(input(), {key: 'Escape'});
  act(() => { runInAction(() => {
    connectivity.online = false;
    app.ui.paletteQuery = 'footer';
    app.ui.paletteOpen = true;
  }); });
  await waitFor(() => { expect(cursor()?.textContent).toContain('Footer links are broken'); });
  expect(app.ui.paletteQuery).toBe('');
  expect((input() as HTMLInputElement).value).toBe('footer');
  fireEvent.click(screen.getByRole('option', {name: /Footer links are broken/}));
  expect(navigate).toHaveBeenCalledOnce();
});

test('repository sections outrank global commands, and page keybindings still run after closing', async () => {
  const {app} = setup();
  fireEvent.keyDown(input(), {key: 'Escape'});
  const pop = shortcuts.pushScope('list');
  const run = vi.fn();
  const off = shortcuts.bind('list.open', run);
  try {
    act(() => { runInAction(() => { app.ui.repoOpen = 20; app.ui.paletteOpen = true; }); });
    await type('issues', 'Go to Issues of acme/website');
    await type('open', 'Open');
    fireEvent.click(screen.getByRole('option', {name: /^Open/, selected: true}));
    await waitFor(() => { expect(run).toHaveBeenCalledOnce(); });
    expect(app.ui.paletteOpen).toBe(false);
  } finally {
    off();
    pop();
  }
});

test('issue rows show their coloured state, merged pull requests included', async () => {
  const {session} = setup();
  session.data.put('Issue', 'repo:20', issue(101, 20, 8, 'Footer merge request', {is_pull: true, state: 'closed'}));
  session.data.put('PullRequest', 'repo:20', {
    id: 50, issue_id: 101, number: 8, status: 'mergeable', head_repo_id: 20, base_repo_id: 20, head_branch: 'feat', base_branch: 'main', merge_base: '',
    allow_maintainer_edit: false, merged: true, merge_commit_sha: '', merger_id: 0, commits_ahead: 1, commits_behind: 0, conflicted_files: [], flow: 0,
  } satisfies PullRequest);
  await type('footer', 'Footer');
  const glyph = (name: RegExp) => screen.getByRole('option', {name}).querySelector('svg');
  expect(glyph(/Footer links are broken/)?.getAttribute('aria-label')).toBe('Open');
  expect(glyph(/Footer links are broken/)?.getAttribute('class')).toContain('text-success');
  expect(glyph(/Footer merge request/)?.getAttribute('aria-label')).toBe('Merged');
  expect(glyph(/Footer merge request/)?.getAttribute('class')).toContain('text-done');
});

test('GitHub prefixes limit the results to one kind', async () => {
  setup();
  await type('#footer', 'Footer links are broken');
  expect(screen.queryByRole('option', {name: /Keyboard shortcuts/})).toBeNull();
  fireEvent.change(input(), {target: {value: '>foot'}});
  await waitFor(() => { expect(screen.queryByRole('option', {name: /Footer links are broken/})).toBeNull(); });
  fireEvent.change(input(), {target: {value: '@'}});
  await screen.findByText('Type to search repositories, people and organizations.');
  await type('@website', 'acme/website');
  expect(screen.queryByRole('option', {name: /Footer links are broken/})).toBeNull();
  await type('>explore', 'Explore');
  fireEvent.keyDown(input(), {key: 'Enter'});
  expect(navigate).toHaveBeenCalledWith({to: '/explore/repos', search: discoverySearch({})});
});

test('a prefix asks Forgejo only for its kinds and picks the matching search page', async () => {
  setup();
  fireEvent.change(input(), {target: {value: '#footer'}});
  await waitFor(() => { expect(server.searchServer).toHaveBeenCalled(); });
  expect(server.searchServerRepos).not.toHaveBeenCalled();
  expect(server.searchServerUsers).not.toHaveBeenCalled();
  expect(screen.queryByRole('option', {name: /Search code for/})).toBeNull();

  fireEvent.change(input(), {target: {value: '@acme'}});
  await waitFor(() => { expect(server.searchServerUsers).toHaveBeenCalledWith(expect.anything(), 'acme', expect.anything()); });
  expect(server.searchServerRepos).toHaveBeenCalledWith(expect.anything(), 'acme', expect.anything());
  expect(server.searchServer).not.toHaveBeenCalledWith(expect.anything(), 'acme', expect.anything());
  expect(screen.queryByRole('option', {name: /Search code for/})).toBeNull();
  fireEvent.click(screen.getByRole('option', {name: 'See all results'}));
  expect(navigate).toHaveBeenCalledWith(expect.objectContaining({to: '/search', search: expect.objectContaining({q: 'acme', type: 'users'}) as unknown}));
});

test('file and board prefixes ask Forgejo nothing; only files offer code search', async () => {
  setup();
  fireEvent.change(input(), {target: {value: '!roadmap'}});
  await screen.findByText(/Nothing found/);
  expect(screen.queryByRole('option', {name: 'See all results'})).toBeNull();
  expect(screen.queryByRole('option', {name: /Search code for/})).toBeNull();
  fireEvent.change(input(), {target: {value: '/main.go'}});
  await screen.findByRole('option', {name: 'Search code for main.go'});
  expect(screen.queryByRole('option', {name: 'See all results'})).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 400));
  for (const fn of Object.values(server)) expect(fn).not.toHaveBeenCalled();
});
