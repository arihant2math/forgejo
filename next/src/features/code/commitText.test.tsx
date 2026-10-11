// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// Which release has a fix: the commit page lists the tags and branches that
// contain the commit, and issue references in commit messages are visible
// links — on the commit page and in a comparison's commit rows.

import {createMemoryHistory} from '@tanstack/react-router';
import {render, screen, within} from '@testing-library/react';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';
import {messageParts} from './commitText.tsx';

const FIX = 'f'.repeat(40);
const RC = 'c'.repeat(40);
const ONE = 'e'.repeat(40);

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('issue references in a message', () => {
  test('#N and owner/repo#N, not inside words, paths or URLs', () => {
    expect(messageParts('docs: add getting started guide (#107)')).toEqual([
      {text: 'docs: add getting started guide ('}, {ref: '#107', repo: undefined, index: '107'}, {text: ')'},
    ]);
    expect(messageParts('Closes #25, see acme/atlas#3.')).toEqual([
      {text: 'Closes '}, {ref: '#25', repo: undefined, index: '25'}, {text: ', see '}, {ref: 'acme/atlas#3', repo: 'acme/atlas', index: '3'}, {text: '.'},
    ]);
    for (const t of ['a#1', 'https://x.org/page#12', 'src/path/to#4', '##5', '#12abc', 'no refs']) {
      expect(messageParts(t).every((p) => 'text' in p), t).toBe(true);
    }
  });
});

const branch = (id: number, name: string, sha: string) => ({
  id, repo_id: 20, name, commit_id: sha, commit_message: `${name} head`, commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T,
});
const tag = (id: number, name: string, sha: string) => ({
  id, repo_id: 20, publisher_id: 1, tag_name: name, target_commitish: 'main', name: '', sha, body: '', body_html: '', draft: false, prerelease: false, is_tag: true,
  num_commits: 1, hide_archive_links: false, original_author: '', created_at: T,
});

function session() {
  const me = user(1, 'alice');
  const acme = user(3, 'acme', 'organization');
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'access'}]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('User', 'org:3', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'atlas'));
  s.data.put('Branch', 'repo:20', branch(1, 'main', FIX));
  s.data.put('Release', 'repo:20', tag(5, 'v1.0.0-rc.1', RC));
  s.data.put('Release', 'repo:20', tag(6, 'v1.0.0', ONE));
  s.auth.token = () => Promise.resolve('token');
  return s;
}

const apiCommit = (sha: string, message: string, parent: string) => ({sha, commit: {message, author: {name: 'Dev', email: 'd@x', date: T}}, author: null, parents: [{sha: parent}]});

function stubForgejo(answer: (url: string) => {status: number; json?: unknown; text?: string} | undefined): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    asked.push(url);
    const a = answer(url) ?? {status: 404, json: {message: 'not here'}};
    return Promise.resolve(new Response(a.text ?? JSON.stringify(a.json), {status: a.status, headers: {'Content-Type': 'application/json'}}));
  }));
  return asked;
}

async function open(app: ReturnType<typeof createApp>, path: string) {
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return router;
}

test('the commit page: references are links, and the tags and branches that contain the commit', async () => {
  const s = session();
  stubForgejo((url) => {
    if (url.includes(`/git/commits/${FIX}?`)) return {status: 200, json: apiCommit(FIX, 'docs: add getting started guide (#107)\n\nCloses #25.', RC)};
    if (url.endsWith(`/-/sync/api/repos/20/refs/${FIX}`)) return {status: 200, json: {branches: ['main'], tags: ['v1.0.0']}};
    if (url.includes(`/repos/20/diff/${FIX}`)) return {status: 200, text: ''};
    return undefined;
  });
  const app = createApp(config, s);
  await open(app, `/acme/atlas/commit/${FIX}`);
  const ref = await screen.findByRole('link', {name: '#107'});
  // The reference is a named link in the commit heading, not plain message text.
  const headings = screen.getAllByRole('heading', {level: 1, name: 'docs: add getting started guide (#107)'});
  expect(headings.flatMap((heading) => within(heading).queryAllByRole('link', {name: '#107'}))).toEqual([ref]);
  expect(ref.getAttribute('href')).toBe('/acme/atlas/issues/107');
  expect(screen.getByRole('link', {name: '#25'}).getAttribute('href')).toBe('/acme/atlas/issues/25');
  const contained = await screen.findByLabelText('Contained in');
  expect(contained.textContent).toMatch(/In 1 tag:\s*v1\.0\.0/);
  expect(within(contained).getByRole('link', {name: 'v1.0.0'}).getAttribute('href')).toBe('/acme/atlas/src/tag/v1.0.0');
  expect(within(contained).getByRole('link', {name: 'main'}).getAttribute('href')).toBe('/acme/atlas/src/branch/main');
});

test('a comparison\'s commit rows link their references', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
  const s = session();
  stubForgejo((url) => {
    if (url.endsWith(`/compare/${RC}...${ONE}`)) return {status: 200, json: {total_commits: 1, commits: [apiCommit(ONE, 'docs: add getting started guide (#107)', RC)]}};
    if (url.includes(`/repos/20/diff/${RC}/${ONE}`)) return {status: 200, text: ''};
    return undefined;
  });
  const app = createApp(config, s);
  await open(app, '/acme/atlas/compare/v1.0.0-rc.1...v1.0.0');
  const rows = await screen.findByRole('listbox', {name: 'Commits'});
  const ref = await within(rows).findByRole('link', {name: '#107'});
  expect(ref.getAttribute('href')).toBe('/acme/atlas/issues/107');
});
