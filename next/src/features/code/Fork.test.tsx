// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Contributing from a fork in the app: a fork's comparison of its own
// branches says that a pull request opened there stays in the fork and
// offers the upstream instead; its branches propose to the upstream; the
// upstream's "New pull request" lists the viewer's fork's branches and takes
// a typed owner:branch; the fork's overview says how far it is ahead of and
// behind the upstream, and syncs it.

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';
import {standingText} from '../repo/Contribute.tsx';

const MAIN = 'b'.repeat(40);
const FIX = 'c'.repeat(40);

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const branch = (id: number, repoId: number, name: string, sha: string) => ({
  id, repo_id: repoId, name, commit_id: sha, commit_message: `${name} head`, commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T,
});

/**
 * alice's fork alice/atlas (20) of acme/atlas (30), with main and fix/typo. `upstreamInPool`: the device has
 * acme/atlas (else API v1 names it).
 */
function session(upstreamInPool = true) {
  const me = user(1, 'alice');
  const acme = user(3, 'acme', 'organization');
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'owner'}, {group: 'repo:30', units: [], reason: 'access'}]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('User', 'org:3', acme);
  s.data.put('Repository', 'repo:20', repo(20, me, 'atlas', {fork: true, parent_id: 30}));
  if (upstreamInPool) s.data.put('Repository', 'repo:30', repo(30, acme, 'atlas', {forks_count: 1}));
  s.data.put('Branch', 'repo:20', branch(1, 20, 'main', MAIN));
  s.data.put('Branch', 'repo:20', branch(2, 20, 'fix/typo', FIX));
  s.auth.token = () => Promise.resolve('token');
  s.data.whenSynced = () => Promise.resolve();
  return s;
}

type Answer = {status: number; json?: unknown; text?: string} | undefined;

function stubForgejo(answer: (method: string, url: string) => Answer): {method: string; url: string}[] {
  const sent: {method: string; url: string}[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') sent.push({method, url});
    const a = answer(method, url) ?? {status: 404, json: {message: 'not here'}};
    const body = a.text ?? (a.json === undefined ? null : JSON.stringify(a.json));
    return Promise.resolve(new Response(a.status === 204 ? null : body, {status: a.status, headers: {'Content-Type': 'application/json'}}));
  }));
  return sent;
}

async function open(app: ReturnType<typeof createApp>, path: string) {
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return router;
}

const commit = (sha: string, message: string, parent: string) => ({sha, commit: {message, author: {name: 'Alice', email: 'a@x', date: T}}, author: null, parents: [{sha: parent}]});
const DIFF = 'diff --git a/docs.md b/docs.md\n--- a/docs.md\n+++ b/docs.md\n@@ -1 +1 @@\n-teh\n+the\n';

/** The fork's own comparison main...fix/typo. */
const forkCompare = (method: string, url: string): Answer => {
  if (method !== 'GET') return undefined;
  if (url.endsWith(`/compare/${MAIN}...${FIX}`)) return {status: 200, json: {total_commits: 1, commits: [commit(FIX, 'Fix a typo', MAIN)]}};
  if (url.endsWith(`/compare/${FIX}...${MAIN}`)) return {status: 200, json: {total_commits: 0, commits: []}};
  if (url.endsWith(`/repos/20/diff/${MAIN}/${FIX}`)) return {status: 200, text: DIFF};
  if (url.includes('/assignees')) return {status: 200, json: []};
  return undefined;
};

test('a fork\'s own comparison says the pull request stays in the fork, and offers the upstream', async () => {
  const s = session();
  stubForgejo(forkCompare);
  const app = createApp(config, s);
  const router = await open(app, '/alice/atlas/compare/main...fix/typo?expand=1');
  const note = await screen.findByRole('note');
  expect(note.textContent).toMatch(/A pull request opened here stays in alice\/atlas/);
  expect(note.textContent).toMatch(/fork of acme\/atlas/);
  const up = within(note).getByRole('link', {name: /Compare with acme\/atlas:main/});
  expect(up.getAttribute('href')).toBe('/acme/atlas/compare/main...alice%3Afix/typo?expand=1');
  // The form names where it opens.
  const form = await screen.findByRole('region', {name: 'Open a pull request'});
  expect(form.textContent).toMatch(/Opens in alice\/atlas: merges fix\/typo into main\./);
  // The base picker offers the upstream too.
  fireEvent.click(screen.getByRole('button', {name: 'Base: main'}));
  expect(await screen.findByText('acme/atlas (upstream)')).toBeTruthy();
  const [own, upstream] = screen.getAllByRole('option', {name: /main/});
  expect(own?.getAttribute('aria-selected')).toBe('true');
  expect(upstream?.getAttribute('aria-selected')).toBe('false');
  act(() => {
    if (upstream) fireEvent.click(upstream);
  });
  await waitFor(() => {
    expect(decodeURIComponent(router.state.location.pathname)).toBe('/acme/atlas/compare/main...alice:fix/typo');
  });
});

test('the upstream is found through API v1 when it is not on the device', async () => {
  const s = session(false);
  stubForgejo((method, url) => {
    if (url.endsWith('/api/v1/repos/alice/atlas')) return {status: 200, json: {default_branch: 'main', parent: {owner: {login: 'acme'}, name: 'atlas', default_branch: 'trunk'}}};
    return forkCompare(method, url);
  });
  const app = createApp(config, s);
  await open(app, '/alice/atlas/compare/main...fix/typo');
  const link = await screen.findByRole('link', {name: /Compare with acme\/atlas:trunk/});
  expect(link.getAttribute('href')).toBe('/acme/atlas/compare/trunk...alice%3Afix/typo');
});

test('a fork\'s branches propose to the upstream', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
  const s = session();
  stubForgejo(() => undefined);
  const app = createApp(config, s);
  await open(app, '/alice/atlas/branches');
  const links = await screen.findAllByRole('link', {name: /New pull request/});
  expect(links.map((l) => l.getAttribute('href')).sort()).toEqual([
    '/acme/atlas/compare/main...alice%3Afix/typo?expand=1',
    '/acme/atlas/compare/main...alice%3Amain?expand=1',
  ]);
  // The fork's own comparison is still there.
  expect(screen.getByRole('link', {name: 'Compare'}).getAttribute('href')).toBe('/alice/atlas/compare/main...fix/typo');
});

test('the upstream\'s New pull request lists the viewer\'s fork\'s branches, and the head picker takes owner:branch', async () => {
  const s = session();
  s.data.put('Branch', 'repo:30', branch(5, 30, 'main', MAIN));
  stubForgejo((_method, url) => {
    if (url.includes('/api/v1/repos/acme/atlas/forks?')) return {status: 200, json: [{id: 20, name: 'atlas', owner: {login: 'alice'}}, {id: 21, name: 'atlas', owner: {login: 'bob'}}]};
    if (url.includes('/api/v1/repos/alice/atlas/branches?')) return {status: 200, json: [{name: 'fix/typo'}]};
    if (url.includes('/api/v1/repos/bob/atlas/branches?')) return {status: 200, json: [{name: 'bobs-change'}]};
    return undefined;
  });
  const app = createApp(config, s);
  const router = await open(app, '/acme/atlas/compare');
  const mine = await screen.findByRole('region', {name: 'Your forks'});
  const link = within(mine).getByRole('link', {name: 'alice:fix/typo'});
  expect(link.getAttribute('href')).toBe('/acme/atlas/compare/main...alice%3Afix/typo?expand=1');
  expect(within(mine).queryByText(/bobs-change/)).toBeNull();
  // The head picker: every fork's branches, found by owner:branch; a typed one that is not listed, too.
  fireEvent.click(screen.getByRole('button', {name: 'Choose the head branch'}));
  const find = await screen.findByRole('combobox');
  fireEvent.change(find, {target: {value: 'bob:bobs'}});
  expect(await screen.findByRole('option', {name: /bobs-change/})).toBeTruthy();
  fireEvent.change(find, {target: {value: 'carol:feature/x'}});
  act(() => {
    fireEvent.click(screen.getByRole('option', {name: /carol:feature\/x/}));
  });
  await waitFor(() => {
    expect(decodeURIComponent(router.state.location.pathname)).toBe('/acme/atlas/compare/main...carol:feature/x');
  });
});

test('the fork\'s overview: ahead of and behind the upstream, and Sync fork', async () => {
  const s = session(false);
  let behind = 2;
  const sent = stubForgejo((method, url) => {
    if (url.endsWith('/api/v1/repos/alice/atlas')) return {status: 200, json: {default_branch: 'main', parent: {owner: {login: 'acme'}, name: 'atlas', default_branch: 'main'}}};
    if (url.endsWith('/api/v1/repos/acme/atlas/compare/main...alice%3Amain')) return {status: 200, json: {total_commits: 0, commits: []}};
    if (method === 'GET' && url.endsWith('/api/v1/repos/alice/atlas/sync_fork')) return {status: 200, json: {allowed: behind > 0, commits_behind: behind}};
    if (method === 'POST' && url.endsWith('/api/v1/repos/alice/atlas/sync_fork')) {
      behind = 0;
      return {status: 204};
    }
    return undefined;
  });
  const app = createApp(config, s);
  await open(app, '/alice/atlas');
  const note = await screen.findByText('This branch is 2 commits behind acme/atlas:main.');
  const callout = note.closest('[role="note"]');
  if (!(callout instanceof HTMLElement)) throw new Error('no callout');
  expect(within(callout).queryByRole('link', {name: /Compare & open pull request/})).toBeNull();
  act(() => {
    fireEvent.click(within(callout).getByRole('button', {name: 'Sync fork'}));
  });
  await waitFor(() => {
    expect(screen.queryByText(/commits behind/)).toBeNull();
  });
  expect(sent.filter((x) => x.url.includes('sync_fork'))).toEqual([{method: 'POST', url: '/api/v1/repos/alice/atlas/sync_fork'}]);
});

test('the standing in words', () => {
  const upstream = {owner: 'acme', name: 'atlas', defaultBranch: 'main'};
  expect(standingText({upstream, branch: 'main', ahead: 1, behind: 0})).toBe('This branch is 1 commit ahead of acme/atlas:main.');
  expect(standingText({upstream, branch: 'main', ahead: 0, behind: 3})).toBe('This branch is 3 commits behind acme/atlas:main.');
  expect(standingText({upstream, branch: 'dev', ahead: 2, behind: 1})).toBe('This branch is 2 commits ahead of acme/atlas:main and 1 commit behind acme/atlas:dev.');
});
