// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {buildOf, isSpaRoute, sitePathOf, strategy} from './routes.ts';

test('canonical routes (B8 spaRoutes) and the rest', () => {
  for (const p of ['/', '/notifications', '/issues', '/pulls/', '/acme/web.site/issues', '/acme/web.site/issues/12', '/acme/api/pulls/3', '/acme/repo', '/acme', '/acme/repo/issues/new-0f8fad5b-d9cb-469f-a165-70867728950e']) expect(isSpaRoute(p), p).toBe(true);
  for (const p of ['/explore', '/dev.keys', '/user/login', '/explore/repos', '/api/v1', '/acme/repo/issues/0', '/acme/repo/issues/x', '/acme/repo/wiki', '/api/v1/issues/1', '/.x/repo/issues', '/acme/repo/issues/1/files', '/user/login', '/acme/repo/pulls/new-0f8fad5b-d9cb-469f-a165-70867728950e', '/acme/repo/issues/new-x']) {
    expect(isSpaRoute(p), p).toBe(false);
  }
  // The classic page asked for by name, and an owner's profile tabs, are classic.
  expect(isSpaRoute('/acme/repo/issues', '?ui=classic')).toBe(false);
  expect(isSpaRoute('/acme', '?tab=activity')).toBe(false);
  expect(isSpaRoute('/acme', '?tab=repositories&q=x')).toBe(true);
});

test('the sub-path', () => {
  expect(sitePathOf('/git/acme/r/issues', '/git')).toBe('/acme/r/issues');
  expect(sitePathOf('/git', '/git')).toBe('/');
  expect(sitePathOf('/gitx/a', '/git')).toBeUndefined();
  expect(sitePathOf('/a', '')).toBe('/a');
});

test('strategies: hashed assets cache-first, navigations, everything else untouched', () => {
  const o = 'https://f.example';
  const s = (url: string, mode = 'cors', method = 'GET') => strategy({url, mode, method}, o, '/-/next/');
  expect(s(`${o}/-/next/assets/index-abc.js`)).toBe('asset');
  expect(s(`${o}/acme/r/issues/1`, 'navigate')).toBe('navigate');
  expect(s(`${o}/api/v1/user`)).toBe('pass');
  expect(s(`${o}/api/v1/user`, 'cors', 'POST')).toBe('pass');
  expect(s('https://other.example/-/next/assets/x.js')).toBe('pass');
});

test('the build version in index.html', () => {
  expect(buildOf('<meta charset="utf-8"><meta name="forgejo-next-build" content="1a2b3c">')).toBe('1a2b3c');
  expect(buildOf('<html>')).toBeUndefined();
});

test('avatars (images below /avatars, /avatar, /repo-avatars) are kept for offline', () => {
  const o = 'https://x.test';
  const img = (path: string) => ({method: 'GET', mode: 'no-cors', url: `${o}${path}`, destination: 'image'});
  expect(strategy(img('/avatars/abc'), o, '/-/next/')).toBe('avatar');
  expect(strategy(img('/git/repo-avatars/1-x'), o, '/git/-/next/', '/git')).toBe('avatar');
  expect(strategy(img('/acme/atlas/raw/branch/main/logo.png'), o, '/-/next/')).toBe('pass');
  expect(strategy({...img('/avatars/abc'), destination: 'document'}, o, '/-/next/')).toBe('pass');
});
