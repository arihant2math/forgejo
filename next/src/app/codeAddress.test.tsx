// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A classic code address (a search hit, a pasted permalink) is rewritten to the app's code view: the fragment
// (`#L14`, the line it names) goes along (#207). Signed out, a code link of a public repository offers its page
// without signing in (#162).

import {createMemoryHistory} from '@tanstack/react-router';
import {cleanup, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {fakeSession, repo, user} from '../test/fakeSession.ts';
import {App} from './App.tsx';
import {publicPageRepo} from './paths.ts';
import {createAppRouter} from './router.tsx';
import {createApp} from './store.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function land(path: string) {
  const s = fakeSession();
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'atlas'));
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  await waitFor(() => { expect(router.state.status).toBe('idle'); });
  return router.state.location;
}

const SHA = 'edac59f0a386906daa24ae1c0b06a8a504f9b9f0';

test('a classic file address keeps its line anchor when the app opens it', async () => {
  const at = await land(`/acme/atlas/src/commit/${SHA}/internal/geo/projection_test.go#L14`);
  expect(at.pathname).toBe(`/acme/atlas/src/commit/${SHA}/internal/geo/projection_test.go`);
  expect(at.hash).toBe('L14');
});

test('a branch address and a blame address keep a line range', async () => {
  const src = await land('/acme/atlas/src/branch/main/internal/geo/projection.go#L19-L24');
  expect(src.pathname).toBe('/acme/atlas/src/branch/main/internal/geo/projection.go');
  expect(src.hash).toBe('L19-L24');
  const blame = await land('/acme/atlas/blame/branch/main/internal/geo/projection.go#L19');
  expect(blame.pathname).toBe('/acme/atlas/blame/branch/main/internal/geo/projection.go');
  expect(blame.hash).toBe('L19');
});

test('a repository address below the base keeps its anchor too', async () => {
  const at = await land('/-/next/acme/atlas/src/branch/main/README.md#L3');
  expect(at.pathname).toBe('/acme/atlas/src/branch/main/README.md');
  expect(at.hash).toBe('L3');
});

test('without an anchor the address gets none', async () => {
  const at = await land('/acme/atlas/src/branch/main/README.md');
  expect(at.pathname).toBe('/acme/atlas/src/branch/main/README.md');
  expect(at.hash).toBe('');
});

test('the repository of a page readable without an account: home, an issue, a code page (#162)', () => {
  expect(publicPageRepo('/acme/atlas')).toEqual({owner: 'acme', repo: 'atlas'});
  expect(publicPageRepo('/acme/atlas/issues/12')).toEqual({owner: 'acme', repo: 'atlas'});
  expect(publicPageRepo('/acme/atlas/src/branch/main/internal/cache/lru.go')).toEqual({owner: 'acme', repo: 'atlas'});
  expect(publicPageRepo(`/acme/atlas/commit/${SHA}`)).toEqual({owner: 'acme', repo: 'atlas'});
  expect(publicPageRepo('/acme/atlas/commits/branch/main')).toEqual({owner: 'acme', repo: 'atlas'});
  expect(publicPageRepo('/acme/atlas/compare/main...fix')).toEqual({owner: 'acme', repo: 'atlas'});
  // Pages that need an account (settings, a new release), and no repository.
  expect(publicPageRepo('/acme/atlas/settings')).toBeUndefined();
  expect(publicPageRepo('/acme/atlas/releases/new')).toBeUndefined();
  expect(publicPageRepo('/acme')).toBeUndefined();
  expect(publicPageRepo('/acme/atlas/src/branch/main/%2e%2e/x')).toBeUndefined();
});

test('signed out, a code link of a public repository offers its page without signing in (#162)', async () => {
  const fetch = vi.fn((url: string) => Promise.resolve(url === '/api/v1/repos/acme/atlas' ?
    new Response(JSON.stringify({private: false}), {status: 200}) : new Response('{}', {status: 404})));
  vi.stubGlobal('fetch', fetch);
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, undefined);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/acme/atlas/src/branch/main/internal/cache/lru.go']}));
  await router.load();
  render(<App app={app} router={router}/>);
  const link = await screen.findByRole('link', {name: 'View this page without signing in'});
  expect(link.getAttribute('href')).toBe('/acme/atlas/src/branch/main/internal/cache/lru.go?ui=classic');
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/repos/acme/atlas');
});

test('a former code address below the base goes on to the code page, with its query and anchor (#162)', async () => {
  const at = await land('/-/next/code/acme/atlas/src/branch/main/README.md/-?display=source#L3');
  expect(at.pathname).toBe('/acme/atlas/src/branch/main/README.md');
  expect(at.searchStr).toBe('?display=source');
  expect(at.hash).toBe('L3');
  // Exactly one final "-" was the terminator: a file named "-" keeps its own.
  expect((await land('/-/next/code/acme/atlas/src/branch/main/-/-')).pathname).toBe('/acme/atlas/src/branch/main/-');
  expect((await land('/-/next/code/acme/atlas/branches/-')).pathname).toBe('/acme/atlas/branches');
  expect((await land('/-/next/code/acme/atlas/compare/main...feature/x/-')).pathname).toBe('/acme/atlas/compare/main...feature/x');
});

test('a file whose path reads like a repository page is still the file (the view names come first)', async () => {
  for (const path of ['/acme/atlas/src/branch/main/issues/new', '/acme/atlas/src/branch/main/settings', '/acme/atlas/src/branch/main/-', '/acme/atlas/blame/branch/main/pulls/3/files']) {
    const at = await land(path);
    expect(at.pathname, path).toBe(path);
    cleanup();
  }
});
