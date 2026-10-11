// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Opening a pull request in the app: the compare page of two branches (pasted
// as Forgejo's address), Forgejo's proposed title, the merge outlook, Create
// → API v1, and the new pull request's page once the pool holds it.

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {runInAction} from 'mobx';
import {afterEach, expect, test, vi} from 'vitest';
import {connectivity} from '../../app/online.ts';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function session() {
  const me = user(1, 'alice');
  const acme = user(2, 'acme', 'organization');
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'owner'}]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  const branch = (id: number, name: string, sha: string, time: string) => ({
    id, repo_id: 20, name, commit_id: sha, commit_message: `${name} head`, commit_time: time, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T,
  });
  s.data.put('Branch', 'repo:20', branch(1, 'main', BASE, '2026-10-01T00:00:00Z'));
  s.data.put('Branch', 'repo:20', branch(2, 'fix/footer', HEAD, '2026-10-05T00:00:00Z'));
  s.auth.token = () => Promise.resolve('token');
  return s;
}

const commit = (sha: string, message: string, parent: string) => ({sha, commit: {message, author: {name: 'Alice', email: 'a@x', date: T}}, author: null, parents: [{sha: parent}]});

const DIFF = 'diff --git a/footer.txt b/footer.txt\n--- a/footer.txt\n+++ b/footer.txt\n@@ -1 +1 @@\n-old\n+new\n';

/** Forgejo for these tests: the comparison's commits and diff, POST /pulls answering #9 at sync id 77. */
function stubForgejo(): {url: string; body: unknown}[] {
  const posts: {url: string; body: unknown}[] = [];
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const url = input;
    const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => Promise.resolve(new Response(JSON.stringify(v), {status, headers: {'Content-Type': 'application/json', ...headers}}));
    if (init?.method === 'POST') {
      posts.push({url, body: JSON.parse(init.body as string) as unknown});
      if (url.endsWith('/api/v1/repos/acme/website/pulls')) return json({number: 9}, 201, {'X-Livesync-Sync-Id': '77'});
      return json({}, 404);
    }
    if (url.endsWith(`/compare/${BASE}...${HEAD}`)) return json({total_commits: 1, commits: [commit(HEAD, 'Fix the footer links\n\nThey pointed at the old site.', BASE)]});
    if (url.endsWith(`/compare/${HEAD}...${BASE}`)) return json({total_commits: 0, commits: []});
    if (url.endsWith(`/repos/20/diff/${BASE}/${HEAD}`)) return Promise.resolve(new Response(DIFF));
    if (url.includes('/assignees')) return json([]);
    return json({message: 'not here'}, 404);
  }));
  return posts;
}

test('a pasted compare address opens the form with Forgejo\'s proposal; Create opens the pull request\'s page once synced', async () => {
  const s = session();
  const posts = stubForgejo();
  const synced = vi.fn(() => Promise.resolve());
  s.data.whenSynced = synced;
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/acme/website/compare/main...fix/footer?expand=1']}));
  await router.load();
  render(<App app={app} router={router}/>);
  expect(router.state.location.pathname).toBe('/-/next/code/acme/website/compare/main...fix/footer/-');
  // One commit: its summary is the title, the rest of its message the description.
  const title = await screen.findByRole<HTMLInputElement>('textbox', {name: 'Title'});
  expect(title.value).toBe('Fix the footer links');
  expect(await screen.findByText('Able to merge: fix/footer is ahead of main.')).toBeTruthy();
  fireEvent.change(title, {target: {value: 'Fix footer links'}});
  act(() => {
    fireEvent.click(screen.getByRole('button', {name: /Create pull request/}));
  });
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/acme/website/pulls/9');
  });
  expect(posts).toEqual([{url: '/api/v1/repos/acme/website/pulls', body: {base: 'main', head: 'fix/footer', title: 'Fix footer links', body: 'They pointed at the old site.'}}]);
  expect(synced).toHaveBeenCalledWith('repo:20', 77, expect.anything());
});

test('without a head: the branches to propose; an open pull request is linked instead of the button', async () => {
  const s = session();
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', {status: 404}))));
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/acme/website/compare']}));
  await router.load();
  const r = render(<App app={app} router={router}/>);
  expect(router.state.location.pathname).toBe('/-/next/code/acme/website/compare/-');
  // (The rows are virtualized: jsdom lays out none of them. headChoices orders them: proposal.test.ts.)
  expect(await screen.findByText('Choose a branch to merge into main')).toBeTruthy();
  expect(screen.getByRole('listbox', {name: 'Branches'})).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Choose the head branch'})).toBeTruthy();
  r.unmount();
  // These branches have an open pull request: its link, no form.
  s.data.put('Issue', 'repo:20', issue(300, 20, 4, 'Fix footer', {is_pull: true}));
  s.data.put('PullRequest', 'repo:20', {
    id: 30, issue_id: 300, number: 4, status: 'mergeable', head_repo_id: 20, base_repo_id: 20, head_branch: 'fix/footer', base_branch: 'main', merge_base: BASE,
    allow_maintainer_edit: false, merged: false, merge_commit_sha: '', merger_id: 0, commits_ahead: 1, commits_behind: 0, conflicted_files: [], flow: 0,
  });
  const router2 = createAppRouter(app, createMemoryHistory({initialEntries: ['/acme/website/compare/main...fix/footer']}));
  await router2.load();
  render(<App app={app} router={router2}/>);
  expect(await screen.findByRole('link', {name: /Pull request #4/})).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'New pull request'})).toBeNull();
});

test('offline: Create says why and sends nothing', async () => {
  const s = session();
  const posts = stubForgejo();
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/acme/website/compare/main...fix/footer?expand=1']}));
  await router.load();
  render(<App app={app} router={router}/>);
  await screen.findByRole('textbox', {name: 'Title'});
  runInAction(() => {
    connectivity.online = false;
  });
  try {
    expect(await screen.findByText('Offline: opening a pull request needs a connection.')).toBeTruthy();
    const create = screen.getByRole('button', {name: /Create pull request/});
    expect(create.getAttribute('aria-disabled')).toBe('true');
    act(() => {
      fireEvent.click(create);
    });
    expect(posts).toEqual([]);
  } finally {
    runInAction(() => {
      connectivity.online = true;
    });
  }
});
