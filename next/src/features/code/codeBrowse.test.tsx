// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';

const MAIN = 'a'.repeat(40);
const OLDER = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);
const FULL = `abc1234567${'0'.repeat(30)}`;

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

// A viewport for the virtualized lists (jsdom lays nothing out).
const sizes = {offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'), offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')};
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {configurable: true, get: () => 800});
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {configurable: true, get: () => 1200});
});

afterEach(() => {
  for (const [name, d] of Object.entries(sizes)) if (d) Object.defineProperty(HTMLElement.prototype, name, d);
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

function session() {
  const me = user(1, 'alice');
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'owner'}]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('Repository', 'repo:20', repo(20, me, 'website'));
  s.data.put('Branch', 'repo:20', {
    id: 1, repo_id: 20, name: 'main', commit_id: MAIN, commit_message: 'main head', commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T,
  });
  s.auth.token = () => Promise.resolve('token');
  return s;
}

const apiCommit = (sha: string, message: string) => ({
  sha, commit: {message, author: {name: 'Dan', email: 'dan@example.com', date: T}}, author: {login: 'dan', avatar_url: ''}, parents: [],
});

function stubForgejo(answer: (url: string) => {status: number; json?: unknown; text?: string} | undefined) {
  const fetch = vi.fn((url: string) => {
    const a = answer(url) ?? {status: 404, json: {message: 'not here'}};
    return Promise.resolve(new Response(a.text ?? JSON.stringify(a.json), {status: a.status, headers: {'Content-Type': 'application/json'}}));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function open(path: string, seed?: (s: ReturnType<typeof session>) => void) {
  const s = session();
  seed?.(s);
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return router;
}

// Auto-retry plus cold page loading can exceed the default timeout under load.
test('a history whose request dropped once is asked again on its own, and shows the commits', {timeout: 30_000}, async () => {
  let drop = 1;
  const fetch = stubForgejo((url) => {
    if (!url.startsWith('/api/v1/repos/alice/website/commits?')) return undefined;
    if (drop-- > 0) throw new TypeError('Failed to fetch');
    return {status: 200, json: [apiCommit(MAIN, 'Lower the timeout')]};
  });
  await open('/alice/website/commits/branch/main');
  expect(await screen.findByRole('listbox', {name: 'Commits'}, {timeout: 15_000})).toBeTruthy();
  expect(screen.getByText('Lower the timeout')).toBeTruthy();
  expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/repos/alice/website/commits?'))).toHaveLength(2);
  expect(screen.queryByText('Not available offline')).toBeNull();
});

test('a history that cannot be loaded while connected says so with a Retry, not "Not available offline"', async () => {
  vi.useFakeTimers({shouldAdvanceTime: true});
  let down = true;
  stubForgejo((url) => {
    if (!url.startsWith('/api/v1/repos/alice/website/commits?')) return undefined;
    if (down) throw new TypeError('Failed to fetch');
    return {status: 200, json: [apiCommit(MAIN, 'Lower the timeout')]};
  });
  await open('/alice/website/commits/branch/main');
  await vi.advanceTimersByTimeAsync(1100);
  await vi.advanceTimersByTimeAsync(3100);
  expect(await screen.findByText('Could not load')).toBeTruthy();
  expect(screen.queryByText('Not available offline')).toBeNull();
  down = false;
  fireEvent.click(await screen.findByRole('button', {name: 'Retry'}));
  expect(await screen.findByText('Lower the timeout')).toBeTruthy();
});

test('a short commit SHA opens the commit at its full SHA', async () => {
  stubForgejo((url) => (url.startsWith('/api/v1/repos/alice/website/git/commits/abc1234567?') ? {status: 200, json: apiCommit(FULL, 'Lower the timeout')} : undefined));
  const router = await open('/alice/website/commit/abc1234567');
  await waitFor(() => {
    expect(router.state.location.pathname).toBe(`/alice/website/commit/${FULL}`);
  });
  router.history.push('/alice/website/src/commit/abc1234567/README.md#L3');
  await waitFor(() => {
    expect(router.state.location.pathname).toBe(`/alice/website/src/commit/${FULL}/README.md`);
  });
  expect(router.state.location.hash).toBe('L3');
});

test('a short SHA that names no commit says so, not "this address does not name a code view"', async () => {
  stubForgejo(() => undefined);
  await open('/alice/website/commit/abc1234567');
  expect(await screen.findByText('The commit abc1234567 does not exist, or you cannot see it.')).toBeTruthy();
  expect(screen.queryByText('This address does not name a code view.')).toBeNull();
});

test('blame links each change to the blame before it, and Raw follows the branch', async () => {
  vi.stubGlobal('Worker', undefined);
  stubForgejo((url) => {
    if (url === `/-/sync/api/repos/20/tree/${MAIN}`) return {status: 200, json: {commit: MAIN, path: '', sha: MAIN, entries: [{name: 'config.go', type: 'blob', mode: '100644', sha: BLOB, size: 30}]}};
    if (url === `/-/sync/api/repos/20/blobs/${BLOB}`) return {status: 200, text: 'package config\n\nTimeout = 2\n'};
    if (url === `/-/sync/api/repos/20/blame/${MAIN}/config.go`) {
      return {status: 200, json: {
        commit: MAIN, path: 'config.go', uses_ignore_revs: false, faulty_ignore_revs_file: false,
        parts: [{sha: OLDER, start_line: 1, lines: 2}, {sha: MAIN, start_line: 3, lines: 1, previous_sha: OLDER, previous_path: 'conf.go'}],
        commits: {
          [OLDER]: {summary: 'Add the config', author_name: 'Alice', author_email: '', author_id: 0, authored_at: T, committed_at: T},
          [MAIN]: {summary: 'Lower the timeout', author_name: 'Dan', author_email: '', author_id: 0, authored_at: T, committed_at: T},
        },
      }};
    }
    return undefined;
  });
  await open('/alice/website/blame/branch/main/config.go');
  const prior = await screen.findByRole('link', {name: 'Blame prior to this change'}, {timeout: 3000});
  // Prior blame must use the path at the parent commit when a file is renamed.
  expect(prior.getAttribute('href')).toBe(`/alice/website/blame/commit/${OLDER}/conf.go`);
  expect(screen.getAllByRole('link', {name: 'Blame prior to this change'})).toHaveLength(1);
  expect(screen.getByRole('link', {name: 'Raw'}).getAttribute('href')).toBe('/alice/website/raw/branch/main/config.go');
});

function fileServer(url: string): {status: number; json?: unknown; text?: string} | undefined {
  if (url === `/-/sync/api/repos/20/tree/${MAIN}`) return {status: 200, json: {commit: MAIN, path: '', sha: MAIN, entries: [{name: 'config.go', type: 'blob', mode: '100644', sha: BLOB, size: 400}]}};
  if (url === `/-/sync/api/repos/20/blobs/${BLOB}`) return {status: 200, text: Array.from({length: 20}, (_, i) => (i === 16 ? '\treturn Config{MaxZoom: 16}' : `// line ${String(i + 1)}`)).join('\n')};
  if (url.startsWith('/-/sync/api/repos/20/search?')) {
    return {status: 200, json: {enabled: false, total: 1, repositories: {'20': 'alice/website'}, results: [{RepoID: 20, Filename: 'config.go', CommitID: MAIN, Lines: [
      {Num: 16, FormattedContent: '// line 16'}, {Num: 17, FormattedContent: '\treturn Config{Max<span class="search-highlight">Zoom</span>: 16}'}, {Num: 18, FormattedContent: '// line 18'},
    ]}]}};
  }
  return undefined;
}

test.each(['src', 'blame'] as const)('%s keeps the view switch, Raw and Edit in the file header, with click and e shortcut intact', async (view) => {
  vi.stubGlobal('Worker', undefined);
  stubForgejo((url) => {
    if (url === `/-/sync/api/repos/20/blame/${MAIN}/config.go`) return {status: 200, json: {
      commit: MAIN, path: 'config.go', uses_ignore_revs: false, faulty_ignore_revs_file: false, parts: [], commits: {},
    }};
    return fileServer(url);
  });
  await open(`/alice/website/${view}/branch/main/config.go`);
  const edit = await screen.findByRole('button', {name: 'Edit this file'});
  expect(screen.getByText('20 lines').parentElement?.contains(edit)).toBe(true);
  const header = screen.getByText('20 lines').parentElement ?? document.body;
  const views = within(header).getByRole('list', {name: 'File view'});
  expect(within(views).getAllByRole('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Code', String(view === 'src')], ['Blame', String(view === 'blame')]]);
  expect(header.contains(screen.getByRole('button', {name: 'Copy raw file'}))).toBe(true);
  expect(screen.getByRole('link', {name: 'Download raw file'}).getAttribute('download')).toBe('config.go');
  expect(screen.queryByRole('button', {name: 'Search code'})).toBeNull();
  const history = screen.getByRole('link', {name: 'History'});
  expect(history.getAttribute('href')).toBe('/alice/website/commits/branch/main/config.go');
  expect(history.getAttribute('data-size')).toBe('small');
  expect(screen.getByRole('link', {name: 'Raw'}).getAttribute('data-size')).toBe('small');
  fireEvent.click(edit);
  expect(await screen.findByRole('textbox', {name: 'File contents'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Close editor'}));
  await screen.findByRole('button', {name: 'Edit this file'});
  fireEvent.keyDown(document, {key: 'e', code: 'KeyE'});
  expect(await screen.findByRole('textbox', {name: 'File contents'})).toBeTruthy();
});

test('a Markdown file opens as a preview; Code switches to ?plain=1 and Blame to the blame view', async () => {
  vi.stubGlobal('Worker', undefined);
  stubForgejo((url) => {
    if (url === `/-/sync/api/repos/20/tree/${MAIN}`) return {status: 200, json: {commit: MAIN, path: '', sha: MAIN, entries: [{name: 'README.md', type: 'blob', mode: '100644', sha: BLOB, size: 8}]}};
    if (url === `/-/sync/api/repos/20/blobs/${BLOB}`) return {status: 200, text: '# Hello\n'};
    if (url === '/-/sync/api/markup') return {status: 200, json: {html: '<h1>Hello</h1>'}};
    return undefined;
  });
  const router = await open('/alice/website/src/branch/main/README.md');
  expect((await screen.findByRole('button', {name: 'Preview'})).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', {name: 'Code'}));
  await waitFor(() => { expect(router.state.location.search).toEqual({plain: '1'}); });
  await waitFor(() => { expect(screen.getByRole('button', {name: 'Code'}).getAttribute('aria-pressed')).toBe('true'); });
  fireEvent.click(screen.getByRole('button', {name: 'Blame'}));
  await waitFor(() => { expect(router.state.location.pathname).toBe('/alice/website/blame/branch/main/README.md'); });
});

test('a file\'s ⋯ menu copies its path and permalink and deletes it; Add file stays with directories', async () => {
  vi.stubGlobal('Worker', undefined);
  stubForgejo(fileServer);
  await open('/alice/website/src/branch/main/config.go');
  fireEvent.click(await screen.findByRole('button', {name: 'File actions'}));
  expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent)).toEqual(['Copy path', 'Copy permalink', 'Delete file']);
  expect(screen.queryByRole('button', {name: 'Add file'})).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', {name: 'Delete file'}));
  expect(await screen.findByRole('dialog', {name: 'Commit changes'})).toBeTruthy();
});

test('a directory keeps Add file in the heading toolbar and still opens uploads', async () => {
  stubForgejo(fileServer);
  await open('/alice/website/src/branch/main');
  const add = await screen.findByRole('button', {name: 'Add file'});
  expect(add.closest('header')?.contains(screen.getByRole('heading', {name: 'Code', level: 1}))).toBe(true);
  fireEvent.click(add);
  fireEvent.click(await screen.findByRole('menuitem', {name: 'Upload files'}));
  expect(await screen.findByRole('dialog', {name: 'Upload files'})).toBeTruthy();
});

async function linkedLine(n: number) {
  await waitFor(() => {
    expect(document.getElementById(`L${String(n)}`)?.hasAttribute('data-linked')).toBe(true);
  }, {timeout: 3000});
}

test('a pasted code link with #L17 opens the file at line 17, highlighted', async () => {
  vi.stubGlobal('Worker', undefined);
  stubForgejo(fileServer);
  const router = await open(`/alice/website/src/commit/${MAIN}/config.go#L17`);
  await linkedLine(17);
  expect(router.state.location.pathname).toBe(`/alice/website/src/commit/${MAIN}/config.go`);
  expect(router.state.location.hash).toBe('L17');
  expect(document.getElementById('L16')?.hasAttribute('data-linked')).toBe(false);
  cleanup();
  const branch = await open('/alice/website/src/branch/main/config.go#L17');
  await linkedLine(17);
  expect(branch.state.location.hash).toBe('L17');
});

test('a code search hit opens its file at the line it names, highlighted', async () => {
  vi.stubGlobal('Worker', undefined);
  stubForgejo(fileServer);
  const router = await open('/search?type=code&repoId=20&q=zoom');
  fireEvent.click(await screen.findByRole('option', {name: 'alice/website / config.go:17'}));
  await linkedLine(17);
  expect(router.state.location.pathname).toBe(`/alice/website/src/commit/${MAIN}/config.go`);
  expect(router.state.location.hash).toBe('L17');
});

test('the ref picker switches between Branches and Tags, links to all of them, and offers to create the typed branch', async () => {
  stubForgejo(fileServer);
  await open('/alice/website/src/branch/main', (s) => {
    s.data.put('Release', 'repo:20', {
      id: 5, repo_id: 20, publisher_id: 1, tag_name: 'v1.0', target_commitish: 'main', name: '', sha: MAIN, body: '', body_html: '', draft: false, prerelease: false, is_tag: true,
      num_commits: 1, hide_archive_links: false, original_author: '', created_at: T,
    });
  });
  fireEvent.click(await screen.findByRole('button', {name: 'Ref: main'}));
  const refs = () => within(screen.getByRole('combobox', {name: 'Switch branches/tags'}).closest('[role="dialog"]') ?? document.body).getAllByRole('option').map((o) => o.textContent);
  expect(refs()).toEqual(['maindefault']);
  expect(screen.getByRole('link', {name: 'View all branches'}).getAttribute('href')).toBe('/alice/website/branches');
  fireEvent.change(screen.getByRole('combobox', {name: 'Switch branches/tags'}), {target: {value: 'topic'}});
  expect(screen.getByRole('option', {name: 'Create branch: topic from main'})).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', {name: 'Switch branches/tags'}), {target: {value: ''}});
  fireEvent.click(screen.getByRole('button', {name: 'Tags'}));
  expect(refs()).toEqual(['v1.0']);
  expect(screen.getByRole('link', {name: 'View all tags'}).getAttribute('href')).toBe('/alice/website/tags');
});
