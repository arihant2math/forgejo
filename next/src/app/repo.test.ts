// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment jsdom

import {afterEach, expect, test, vi} from 'vitest';
import {fakeSession} from '../test/fakeSession.ts';
import {accessKnown, confirmAccess, repoAccess} from './access.ts';
import {fallbackConfig} from './config.ts';
import {loadRepo, repoGone} from './repo.ts';
import {createApp} from './store.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(answer: (url: string) => Response) {
  const session = fakeSession({userId: 1});
  vi.spyOn(session.auth, 'token').mockResolvedValue('t');
  const fetchMock = vi.fn((url: string, _init?: RequestInit) => Promise.resolve(answer(url)));
  vi.stubGlobal('fetch', fetchMock);
  return {app: createApp(fallbackConfig(), session), session, fetchMock};
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {status, headers: {'Content-Type': 'application/json'}});

test('a repository outside the pool is asked for once, through api.send, for the route and for access', async () => {
  const {app, session, fetchMock} = setup(() => json({id: 41, permissions: {admin: false, push: true}}));
  const route = loadRepo(app, 'Acme', 'Tools');
  confirmAccess(app, 'acme', 'tools', 41);
  expect(await route).toEqual({repoId: 41});
  await vi.waitFor(() => {
    expect(accessKnown(session, 41)).toBe(true);
  });
  expect(repoAccess(session, 41)).toBe('write');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toContain('/api/v1/repos/Acme/Tools');
  expect(init?.redirect).toBe('manual');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer t');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(await loadRepo(app, 'acme', 'tools')).toEqual({repoId: 41});
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a 404 is not found and asked again next time; repoGone rechecks', async () => {
  let status = 404;
  const {app, fetchMock} = setup(() => (status === 404 ? json({message: 'not found'}, 404) : json({id: 42})));
  expect(await loadRepo(app, 'acme', 'gone')).toEqual({repoId: undefined, notFound: true});
  expect(await repoGone(app, 'acme', 'gone')).toBe(true);
  status = 200;
  expect(await repoGone(app, 'acme', 'gone')).toBe(false);
  expect(await loadRepo(app, 'acme', 'gone')).toEqual({repoId: 42});
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
