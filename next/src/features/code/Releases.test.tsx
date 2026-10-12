// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';

const MAIN = 'a'.repeat(40);
const RC = 'c'.repeat(40);
const OLD = 'd'.repeat(40);

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const branch = (id: number, name: string, sha: string) => ({
  id, repo_id: 20, name, commit_id: sha, commit_message: `${name} head`, commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T,
});

const release = (id: number, tag: string, sha: string, extra = {}) => ({
  id, repo_id: 20, publisher_id: 1, tag_name: tag, target_commitish: 'main', name: '', sha, body: '', body_html: '', draft: false, prerelease: false, is_tag: false,
  num_commits: 1, hide_archive_links: false, original_author: '', created_at: T, ...extra,
});

function session(writer = true) {
  const me = user(1, 'alice');
  const s = fakeSession({workspace: {viewer_id: writer ? 1 : 2, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: writer ? 'owner' : 'access'}]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('Repository', 'repo:20', repo(20, me, 'website'));
  s.data.put('Branch', 'repo:20', branch(1, 'main', MAIN));
  s.data.put('Release', 'repo:20', release(4, 'v0.9', OLD, {name: 'Nine', created_at: '2026-09-01T00:00:00Z'}));
  s.data.put('Release', 'repo:20', release(5, 'v1.0', OLD, {name: 'One', created_at: '2026-09-10T00:00:00Z'}));
  s.data.put('Release', 'repo:20', release(6, 'v1.1-rc.1', RC, {name: 'Candidate', prerelease: true, created_at: '2026-09-20T00:00:00Z'}));
  s.auth.token = () => Promise.resolve('token');
  s.data.whenSynced = () => Promise.resolve();
  return s;
}

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

function stubForgejo(answer: (method: string, url: string) => {status: number; json: unknown} | undefined): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : init?.body;
    if (method !== 'GET') sent.push({method, url, body});
    const a = answer(method, url) ?? {status: 404, json: {message: 'not here'}};
    return Promise.resolve(new Response(JSON.stringify(a.json), {status: a.status, headers: {'Content-Type': 'application/json', 'X-Livesync-Sync-Id': '40'}}));
  }));
  return sent;
}

async function open(app: ReturnType<typeof createApp>, path: string) {
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return router;
}

const commits = (n: number) => Array.from({length: n}, (_, i) => ({sha: String(i).repeat(40).slice(0, 40), commit: {message: `change ${String(i)}`, author: {name: 'a', email: 'a@x', date: T}}, parents: []}));

test('the releases list marks the latest release (not the newer pre-release) and counts the commits to main since each', async () => {
  const s = session(false);
  stubForgejo((_method, url) => {
    if (url.endsWith(`/compare/${OLD}...${MAIN}`)) return {status: 200, json: {total_commits: 11, commits: commits(11)}};
    if (url.endsWith(`/compare/${RC}...${MAIN}`)) return {status: 200, json: {total_commits: 1, commits: commits(1)}};
    return undefined;
  });
  const app = createApp(config, s);
  await open(app, '/alice/website/releases');
  const one = (await screen.findByRole('heading', {name: 'One'})).closest('article');
  const rc = screen.getByRole('heading', {name: 'Candidate'}).closest('article');
  const nine = screen.getByRole('heading', {name: 'Nine'}).closest('article');
  if (!one || !rc || !nine) throw new Error('no release cards');
  expect(within(one).getByText('Latest')).toBeTruthy();
  expect(within(rc).queryByText('Latest')).toBeNull();
  expect(within(rc).getByText('Pre-release')).toBeTruthy();
  expect(within(nine).queryByText('Latest')).toBeNull();
  const since = await within(one).findByRole('link', {name: /11 commits to main since this release/});
  expect(since.getAttribute('href')).toBe('/alice/website/compare/v1.0...main');
  const rcSince = await within(rc).findByRole('link', {name: /1 commit to main since this release/});
  expect(rcSince.getAttribute('href')).toBe('/alice/website/compare/v1.1-rc.1...main');
});

test('every tag row compares the tag with the default branch', async () => {
  // The rows are virtualized: the scroller needs a size in jsdom.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
  const s = session(false);
  stubForgejo(() => undefined);
  const app = createApp(config, s);
  await open(app, '/alice/website/tags');
  const link = await screen.findByRole('link', {name: 'Compare v1.1-rc.1 with main'});
  expect(link.getAttribute('href')).toBe('/alice/website/compare/v1.1-rc.1...main');
  expect(screen.getByRole('link', {name: 'Compare v0.9 with main'})).toBeTruthy();
});

test('a draft\'s card says where its tag will be made, and at which commit', async () => {
  const s = session();
  const draft = {id: 9, tag_name: 'v2.0', target_commitish: 'v1.1-rc.1', name: 'Two', body: '', draft: true, prerelease: false, created_at: T, assets: []};
  stubForgejo((method, url) => {
    if (method === 'GET' && url.includes('/releases?draft=true')) return {status: 200, json: [draft, {...draft, id: 10, tag_name: 'v3.0', name: 'Three', target_commitish: 'main'}]};
    return undefined;
  });
  const app = createApp(config, s);
  await open(app, '/alice/website/releases');
  const two = await screen.findByRole('article', {name: 'Draft Two'});
  expect(two.textContent).toMatch(/from tag v1\.1-rc\.1 at cccccccccc/);
  const three = screen.getByRole('article', {name: 'Draft Three'});
  expect(three.textContent).toMatch(/from branch main at aaaaaaaaaa \(its head when published\)/);
});

test('a release\'s new tag can be made at an existing tag (the release candidate) or a commit, and the form shows the commit', async () => {
  const s = session();
  const sent = stubForgejo((method, url) => {
    if (method === 'GET' && url.includes('/releases?draft=true')) return {status: 200, json: []};
    if (method === 'GET' && url.includes(`/git/commits/${MAIN}?`)) return {status: 200, json: {sha: MAIN, commit: {message: 'Main head\n\nbody', author: {name: 'a', email: 'a@x', date: T}}, parents: []}};
    if (method === 'GET' && url.includes(`/git/commits/${RC}?`)) return {status: 200, json: {sha: RC, commit: {message: 'Release candidate', author: {name: 'a', email: 'a@x', date: T}}, parents: []}};
    if (method === 'GET' && url.includes('/git/commits/1234567?')) return {status: 200, json: {sha: `1234567${'0'.repeat(33)}`, commit: {message: 'Old fix', author: {name: 'a', email: 'a@x', date: T}}, parents: []}};
    if (method === 'GET' && url.includes('/git/commits/')) return {status: 404, json: {message: 'not found'}};
    if (method === 'POST' && url.endsWith('/api/v1/repos/alice/website/releases')) return {status: 201, json: {id: 11, tag_name: 'v2.0'}};
    return undefined;
  });
  const app = createApp(config, s);
  await open(app, '/alice/website/releases/new');
  fireEvent.change(await screen.findByRole('textbox', {name: 'Tag name'}), {target: {value: 'v2.0'}});
  const status = await screen.findByRole('status', {name: 'Target commit'});
  await waitFor(() => {
    expect(status.textContent).toMatch(/aaaaaaaaaa.*Main head/);
  });
  expect(status.textContent).toMatch(/head now/);
  fireEvent.click(screen.getByRole('button', {name: 'Target: main'}));
  const rc = await screen.findByRole('option', {name: /v1\.1-rc\.1/});
  expect(screen.getByRole('option', {name: /^main/}).getAttribute('aria-selected')).toBe('true');
  expect(rc.getAttribute('aria-selected')).toBe('false');
  fireEvent.click(rc);
  await waitFor(() => {
    expect(screen.getByRole('status', {name: 'Target commit'}).textContent).toMatch(/cccccccccc.*Release candidate/);
  });
  fireEvent.click(screen.getByRole('button', {name: 'Target: v1.1-rc.1'}));
  const find = await screen.findByRole('combobox');
  fireEvent.change(find, {target: {value: 'deadbeef'}});
  fireEvent.click(await screen.findByRole('option', {name: /deadbeef/}));
  expect(await screen.findByText('No commit deadbeef in this repository.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Target: deadbeef'}));
  fireEvent.change(await screen.findByRole('combobox'), {target: {value: '1234567'}});
  fireEvent.click(await screen.findByRole('option', {name: /1234567/}));
  await waitFor(() => {
    expect(screen.getByRole('status', {name: 'Target commit'}).textContent).toMatch(/1234567000.*Old fix/);
  });
  act(() => {
    fireEvent.click(screen.getByRole('button', {name: 'Save draft'}));
  });
  await waitFor(() => {
    expect(sent.length).toBe(1);
  });
  expect(sent[0]?.body).toMatchObject({tag_name: 'v2.0', target_commitish: '1234567', draft: true});
});

test('a tag\'s code view compares the tag with the default branch', async () => {
  const s = session(false);
  stubForgejo(() => undefined);
  const app = createApp(config, s);
  await open(app, '/alice/website/src/tag/v1.0');
  const link = await screen.findByRole('link', {name: 'Compare'});
  expect(link.getAttribute('href')).toBe('/alice/website/compare/v1.0...main');
});
