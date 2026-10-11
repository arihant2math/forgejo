// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import type {NextConfig} from '../protocol/types.gen.ts';
import {claimClassicHandoff, fromClassicSignIn} from './gate.ts';
import {publicPageRepo} from './paths.ts';

function config(sub = '', oauth = true): NextConfig {
  return {
    app_url: `http://code.example${sub}/`, app_sub_url: sub, base: `${sub}/-/next/`, app_name: 'Forgejo', version: '', protocol: 1,
    oauth: oauth ?
      {client_id: 'cid', redirect_uri: `http://code.example${sub}/-/next/callback`, scope: 'write:issue', authorize_url: '/login/oauth/authorize', token_url: '/login/oauth/access_token'} :
      null,
  };
}

// The signed-out screen's public-page check (paths.ts publicPageRepo) never takes a reserved page for a repository.
test.each(['/user/settings', '/user/login', '/repo/create', '/org/create', '/explore/repos', '/-/next', '/admin/users', '/User/Settings'])(
  'a reserved first segment (%s) is a page, never a repository: no probe', (path) => {
    expect(publicPageRepo(path)).toBeUndefined();
  });

test('Forgejo\'s own sign-in pages on this instance are recognised as the referrer', () => {
  const c = config();
  const origin = 'http://code.example';
  expect(fromClassicSignIn(c, 'http://code.example/user/login', origin)).toBe(true);
  expect(fromClassicSignIn(c, 'http://code.example/user/login?redirect_to=%2Facme', origin)).toBe(true);
  expect(fromClassicSignIn(c, 'http://code.example/user/two_factor', origin)).toBe(true);
  expect(fromClassicSignIn(c, 'http://code.example/user/webauthn', origin)).toBe(true);
  expect(fromClassicSignIn(c, 'http://code.example/user/sign_up', origin)).toBe(true);
  // Not a sign-in page, another origin, no referrer.
  expect(fromClassicSignIn(c, 'http://code.example/explore/repos', origin)).toBe(false);
  expect(fromClassicSignIn(c, 'http://code.example/user/settings', origin)).toBe(false);
  expect(fromClassicSignIn(c, 'https://evil.example/user/login', origin)).toBe(false);
  expect(fromClassicSignIn(c, '', origin)).toBe(false);
  expect(fromClassicSignIn(c, 'not a url', origin)).toBe(false);
  // Below a sub-path.
  const sub = config('/git');
  expect(fromClassicSignIn(sub, 'http://code.example/git/user/login', origin)).toBe(true);
  expect(fromClassicSignIn(sub, 'http://code.example/user/login', origin)).toBe(false);
});

test('the hand-off from a classic sign-in is claimed once per tab (no loop), and needs OAuth2', () => {
  const origin = 'http://code.example';
  const ref = 'http://code.example/user/login';
  const values = new Map<string, string>();
  const tab = {getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v)};
  expect(claimClassicHandoff(config('', false), ref, origin, 1_000, tab)).toBe(false);
  expect(claimClassicHandoff(config(), 'http://code.example/explore', origin, 1_000, tab)).toBe(false);
  expect(claimClassicHandoff(config(), ref, origin, 1_000, tab)).toBe(true);
  // Back on the gate soon after (the authorization was cancelled): the screen waits for a click.
  expect(claimClassicHandoff(config(), ref, origin, 30_000, tab)).toBe(false);
  // A later sign-in in the same tab hands off again.
  expect(claimClassicHandoff(config(), ref, origin, 10 * 60_000, tab)).toBe(true);
});
