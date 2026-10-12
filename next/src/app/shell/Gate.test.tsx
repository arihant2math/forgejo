// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {App} from '../App.tsx';
import {createAppRouter} from '../router.tsx';
import {createApp} from '../store.ts';

const startSignIn = vi.hoisted(() => vi.fn((_config: unknown, _returnTo: string) => Promise.resolve()));
vi.mock('../../auth/signin.ts', () => ({startSignIn}));

function config(): NextConfig {
  return {
    app_url: 'http://localhost:3000/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1,
    oauth: {client_id: 'cid', redirect_uri: 'http://localhost:3000/-/next/callback', scope: 'write:issue', authorize_url: '/login/oauth/authorize', token_url: '/login/oauth/access_token'},
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({private: false}), {status: 200})));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  startSignIn.mockClear();
  sessionStorage.clear();
  Object.defineProperty(document, 'referrer', {value: '', configurable: true});
});

async function renderGate(path: string) {
  const app = createApp(config(), undefined);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return app;
}

const repoRequests = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/v1/repos/'));

test.each(['/user/settings', '/repo/create', '/org/create'])('signed out on %s: no repository is asked for', async (path) => {
  await renderGate(path);
  expect(screen.getByRole('button', {name: 'Sign in'})).toBeTruthy();
  await new Promise((r) => setTimeout(r, 0));
  expect(repoRequests()).toEqual([]);
  expect(screen.queryByText('View this page without signing in')).toBeNull();
});

test('signed out on a public repository: it is checked anonymously and offered without signing in', async () => {
  await renderGate('/acme/atlas');
  await waitFor(() => {
    expect(repoRequests()).toEqual(['/api/v1/repos/acme/atlas']);
  });
  expect(await screen.findByText('View this page without signing in')).toBeTruthy();
  expect(startSignIn).not.toHaveBeenCalled();
});

test('the gate says that signing in connects an existing Forgejo session', async () => {
  await renderGate('/');
  expect(screen.getByText(/Sign in to continue\. Already signed in to Forgejo\?/)).toBeTruthy();
  expect(startSignIn).not.toHaveBeenCalled();
});

test('opened right after Forgejo\'s sign-in form: the app\'s sign-in continues by itself, once', async () => {
  Object.defineProperty(document, 'referrer', {value: `${location.origin}/user/login`, configurable: true});
  await renderGate('/acme/atlas/issues/90');
  expect(screen.getByText('You are signed in to Forgejo. Connecting Forgejo Next to your account…')).toBeTruthy();
  await waitFor(() => {
    expect(startSignIn).toHaveBeenCalledTimes(1);
  });
  expect(startSignIn.mock.calls[0]?.[1]).toBe(`${location.pathname}${location.search}`);
  await renderGate('/');
  await new Promise((r) => setTimeout(r, 0));
  expect(startSignIn).toHaveBeenCalledTimes(1);
});
