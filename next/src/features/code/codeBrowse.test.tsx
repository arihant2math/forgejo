// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Code views in the app against a stubbed Forgejo: a history whose request drops is asked again (#196), a short
// commit SHA resolves to the full one (#186), blame leads to the blame before a change (#187), and Raw follows the
// branch viewed (#162).

import {createMemoryHistory} from '@tanstack/react-router';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
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

/** Forgejo: `answer` per request URL (undefined: 404); a thrown error is a request that never got an answer. */
function stubForgejo(answer: (url: string) => {status: number; json?: unknown; text?: string} | undefined) {
  const fetch = vi.fn((url: string) => {
    const a = answer(url) ?? {status: 404, json: {message: 'not here'}};
    return Promise.resolve(new Response(a.text ?? JSON.stringify(a.json), {status: a.status, headers: {'Content-Type': 'application/json'}}));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function open(path: string) {
  const app = createApp(config, session());
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return router;
}

test('a history whose request dropped once is asked again on its own, and shows the commits (#196)', async () => {
  let drop = 1;
  const fetch = stubForgejo((url) => {
    if (!url.startsWith('/api/v1/repos/alice/website/commits?')) return undefined;
    if (drop-- > 0) throw new TypeError('Failed to fetch');
    return {status: 200, json: [apiCommit(MAIN, 'Lower the timeout')]};
  });
  await open('/alice/website/commits/branch/main');
  expect(await screen.findByRole('listbox', {name: 'Commits'}, {timeout: 3000})).toBeTruthy();
  expect(screen.getByText('Lower the timeout')).toBeTruthy();
  expect(fetch.mock.calls.filter(([url]) => url.startsWith('/api/v1/repos/alice/website/commits?'))).toHaveLength(2);
  expect(screen.queryByText('Not available offline')).toBeNull();
});

test('a history that cannot be loaded while connected says so with a Retry, not "Not available offline" (#196)', async () => {
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

test('a short commit SHA opens the commit at its full SHA (#186)', async () => {
  stubForgejo((url) => (url.startsWith('/api/v1/repos/alice/website/git/commits/abc1234567?') ? {status: 200, json: apiCommit(FULL, 'Lower the timeout')} : undefined));
  const router = await open('/alice/website/commit/abc1234567');
  await waitFor(() => {
    expect(router.state.location.pathname).toBe(`/alice/website/commit/${FULL}`);
  });
  // The same for a file at a short SHA (its line kept).
  router.history.push('/alice/website/src/commit/abc1234567/README.md#L3');
  await waitFor(() => {
    expect(router.state.location.pathname).toBe(`/alice/website/src/commit/${FULL}/README.md`);
  });
  expect(router.state.location.hash).toBe('L3');
});

test('a short SHA that names no commit says so, not "this address does not name a code view" (#186)', async () => {
  stubForgejo(() => undefined);
  await open('/alice/website/commit/abc1234567');
  expect(await screen.findByText('The commit abc1234567 does not exist, or you cannot see it.')).toBeTruthy();
  expect(screen.queryByText('This address does not name a code view.')).toBeNull();
});

test('blame links each change to the blame before it, and Raw follows the branch (#187, #162)', async () => {
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
  // The file by its name at the parent (it was renamed by the change).
  expect(prior.getAttribute('href')).toBe(`/alice/website/blame/commit/${OLDER}/conf.go`);
  // The first commit has no earlier one: one such link.
  expect(screen.getAllByRole('link', {name: 'Blame prior to this change'})).toHaveLength(1);
  expect(screen.getByRole('link', {name: 'Raw'}).getAttribute('href')).toBe('/alice/website/raw/branch/main/config.go');
});
