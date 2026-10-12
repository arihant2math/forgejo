// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// A distinct tip with no commits ahead must not offer a pull-request form.

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';

const MAIN = 'b'.repeat(40);
const MERGED = 'a'.repeat(40);
const AHEAD = 'c'.repeat(40);
const FORKED = 'd'.repeat(40);
const STALE = 'e'.repeat(40);

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const branch = (id: number, name: string, sha: string) => ({
  id, repo_id: 20, name, commit_id: sha, commit_message: `${name} head`, commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T,
});

function session() {
  const me = user(1, 'alice');
  const acme = user(2, 'acme', 'organization');
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'owner'}]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  s.data.put('Branch', 'repo:20', branch(1, 'main', MAIN));
  s.data.put('Branch', 'repo:20', branch(2, 'docs/merged', MERGED));
  s.data.put('Branch', 'repo:20', branch(3, 'fix/footer', AHEAD));
  s.data.put('Branch', 'repo:20', branch(4, 'stale', STALE));
  s.data.put('Release', 'repo:20', {
    id: 5, repo_id: 20, publisher_id: 1, tag_name: 'v1.0', target_commitish: 'main', name: '', sha: MERGED, body: '', body_html: '', draft: false, prerelease: false, is_tag: true,
    num_commits: 1, hide_archive_links: false, original_author: '', created_at: T,
  });
  s.auth.token = () => Promise.resolve('token');
  return s;
}

const commit = (sha: string, message: string, parent: string) => ({sha, commit: {message, author: {name: 'Alice', email: 'a@x', date: T}}, author: null, parents: [{sha: parent}]});
const DIFF = 'diff --git a/footer.txt b/footer.txt\n--- a/footer.txt\n+++ b/footer.txt\n@@ -1 +1 @@\n-old\n+new\n';

function stubForgejo(): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    asked.push(url);
    const json = (v: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(v), {status, headers: {'Content-Type': 'application/json'}}));
    if (url.endsWith(`/compare/${MAIN}...${MERGED}`)) return json({total_commits: 0, commits: []});
    if (url.endsWith(`/compare/${MERGED}...${MAIN}`)) return json({total_commits: 11, commits: [commit(MAIN, 'later', MERGED)]});
    if (url.endsWith(`/compare/${MAIN}...${AHEAD}`)) return json({total_commits: 1, commits: [commit(AHEAD, 'Fix the footer links', MAIN)]});
    if (url.endsWith(`/compare/${AHEAD}...${MAIN}`)) return json({total_commits: 0, commits: []});
    if (url.endsWith(`/compare/${MAIN}...${STALE}`)) return json({total_commits: 1, commits: [commit(STALE, 'Reword the footer', FORKED)]});
    if (url.endsWith(`/compare/${STALE}...${MAIN}`)) return json({total_commits: 2, commits: [commit(MAIN, 'b', 'f'.repeat(40)), commit('f'.repeat(40), 'a', FORKED)], files: [{filename: 'footer.txt'}, {filename: 'other.txt'}, {filename: 'footer.txt'}]});
    if (url.endsWith(`/repos/20/diff/${MAIN}/${AHEAD}`)) return Promise.resolve(new Response(DIFF));
    if (url.endsWith(`/repos/20/diff/${FORKED}/${STALE}`)) return Promise.resolve(new Response(DIFF));
    if (url.endsWith(`/repos/20/diff/${MERGED}/${MAIN}`)) return Promise.resolve(new Response(DIFF));
    if (url.includes('/assignees')) return json([]);
    return json({message: 'not here'}, 404);
  }));
  return asked;
}

async function open(path: string) {
  const app = createApp(config, session());
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return router;
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

test('a branch merged into the base: nothing to compare, and no Create pull request button (#245)', async () => {
  const asked = stubForgejo();
  await open('/acme/website/compare/main...docs%2Fmerged');
  expect(await screen.findByText('docs/merged has no commits that main lacks. There is nothing to open a pull request for.')).toBeTruthy();
  await settle();
  expect(screen.queryByRole('button', {name: 'Create pull request'})).toBeNull();
  // The header and body share a cached comparison.
  expect(asked.filter((u) => u.endsWith(`/compare/${MAIN}...${MERGED}`))).toHaveLength(1);
});

test('?expand=1 on a branch with nothing to merge: the same state, no empty form (#245)', async () => {
  stubForgejo();
  await open('/acme/website/compare/main...docs%2Fmerged?expand=1');
  expect(await screen.findByText(/There is nothing to open a pull request for\./)).toBeTruthy();
  await settle();
  expect(screen.queryByRole('region', {name: 'Open a pull request'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Create pull request'})).toBeNull();
});

test('a branch ahead of the base: Create pull request in the merge-status box once its comparison is known, and it opens the form', async () => {
  stubForgejo();
  await open('/acme/website/compare/main...fix/footer');
  const button = await screen.findByRole('button', {name: 'Create pull request'});
  expect(button.closest('header')).toBeNull();
  expect(screen.getByRole('button', {name: 'Base: main'}).textContent).toBe('base:main');
  act(() => {
    fireEvent.click(button);
  });
  const form = await screen.findByRole('region', {name: 'Open a pull request'});
  // Only the form's own submit remains.
  expect(screen.getAllByRole('button', {name: 'Create pull request'}).every((b) => form.contains(b))).toBe(true);
});

test('a tag compared with the default branch (the tag\'s Compare): the commits since, and no pull request', async () => {
  stubForgejo();
  await open('/acme/website/compare/v1.0...main');
  expect(await screen.findByText('11 commits')).toBeTruthy();
  await settle();
  expect(screen.queryByRole('button', {name: 'Create pull request'})).toBeNull();
});

test('a branch behind its base: the overlap comes from the base side\'s commit list, without its diff', async () => {
  const asked = stubForgejo();
  await open('/acme/website/compare/main...stale');
  expect((await screen.findByText(/Both branches change 1 file since they diverged/)).textContent).toContain('(footer.txt)');
  expect(asked.filter((u) => u.includes(`/diff/${FORKED}/${MAIN}`))).toEqual([]);
});
