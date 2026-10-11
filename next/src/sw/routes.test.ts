// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {buildOf, isSpaRoute, sitePathOf, strategy} from './routes.ts';

test('canonical routes (B8 spaRoutes) and the rest', () => {
  for (const p of ['/acme/repo/settings', '/acme/repo/settings/collaboration', '/acme/repo/settings/branches', '/acme/repo/settings/hooks', '/acme/repo/settings/keys']) expect(isSpaRoute(p), p).toBe(true);
  for (const p of ['/acme/repo/settings/units', '/acme/repo/settings/hooks/git', '/acme/repo/settings/hooks/3', '/acme/repo/settings/keys/x', '/explore/repo/settings']) expect(isSpaRoute(p), p).toBe(false);
  for (const p of ['/', '/notifications', '/issues', '/pulls/', '/acme/web.site/issues', '/acme/web.site/issues/12', '/acme/api/pulls/3', '/acme/repo', '/acme', '/acme/repo/issues/new-0f8fad5b-d9cb-469f-a165-70867728950e', '/acme/repo/wiki', '/acme/repo/wiki/', '/acme/repo/wiki/Getting-Started', '/acme/repo/wiki/C%2B%2B', '/acme/repo/wiki/-/pages', '/acme/repo/wiki/-/new', '/acme/repo/wiki/Home/-/edit', '/repo/create', '/org/create']) expect(isSpaRoute(p), p).toBe(true);
  for (const p of ['/explore', '/dev.keys', '/user/login', '/explore/repos', '/api/v1', '/acme/repo/issues/0', '/acme/repo/issues/x', '/acme/repo/wiki/raw/logo.png', '/acme/repo/wiki/search', '/acme/repo/wiki/_pages', '/acme/repo/wiki/a%2Fb', '/acme/repo/wiki/-/history', '/api/v1/issues/1', '/.x/repo/issues', '/acme/repo/issues/1/files', '/user/login', '/acme/repo/pulls/new-0f8fad5b-d9cb-469f-a165-70867728950e', '/acme/repo/issues/new-x', '/repo/migrate', '/repo/create/x', '/org/acme', '/org/create/x', '/user/create']) {
    expect(isSpaRoute(p), p).toBe(false);
  }
  // Comparisons (spa.go compareAddress): a pasted compare address opens the app's page for it.
  for (const p of ['/acme/repo/compare', '/acme/repo/compare/feature', '/acme/repo/compare/main...feature/x', '/acme/repo/compare/main...alice:feature']) expect(isSpaRoute(p), p).toBe(true);
  for (const p of ['/acme/repo/compare/main..feature', '/acme/repo/compare/main...feature.diff', '/acme/repo/compare/feature.patch', '/acme/repo/compare/main...', '/acme/repo/compare/...x']) {
    expect(isSpaRoute(p), p).toBe(false);
  }
  // A writer's release form (spa.go codeAddress): a new release, a tag's release to edit; a release's page is classic.
  for (const p of ['/acme/repo/releases', '/acme/repo/releases/new', '/acme/repo/releases/edit/v1.0', '/acme/repo/releases/edit/release/1.0']) expect(isSpaRoute(p), p).toBe(true);
  for (const p of ['/acme/repo/releases/tag/v1', '/acme/repo/releases/edit', '/acme/repo/releases/new/x', '/acme/repo/releases/latest']) expect(isSpaRoute(p), p).toBe(false);
  // The activity pages (spa.go activityPeriods): the Pulse of a period, and its graphs.
  for (const p of ['/acme/repo/activity', '/acme/repo/activity/monthly', '/acme/repo/activity/daily', '/acme/repo/activity/contributors', '/acme/repo/activity/code-frequency', '/acme/repo/activity/recent-commits']) {
    expect(isSpaRoute(p), p).toBe(true);
  }
  for (const p of ['/acme/repo/activity/hourly', '/acme/repo/activity/contributors/data', '/acme/repo/activity/weekly/x', '/acme/repo/activity_author_data']) {
    expect(isSpaRoute(p), p).toBe(false);
  }
  // The viewer's settings: four pages of the app, the rest classic.
  for (const p of ['/user/settings', '/user/settings/', '/user/settings/account', '/user/settings/appearance', '/user/settings/keys']) expect(isSpaRoute(p), p).toBe(true);
  for (const p of ['/user', '/user/settings/applications', '/user/settings/security', '/user/settings/keys/1', '/user/settingsx', '/user/login']) expect(isSpaRoute(p), p).toBe(false);
  expect(isSpaRoute('/user/settings', '?ui=classic')).toBe(false);
  // Labels and milestones (features/meta).
  for (const p of ['/acme/repo/labels', '/acme/repo/milestones', '/acme/repo/milestones/new', '/acme/repo/milestone/3', '/acme/repo/milestone/3/edit']) expect(isSpaRoute(p), p).toBe(true);
  for (const p of ['/acme/repo/labels/1', '/acme/repo/milestones/3', '/acme/repo/milestone', '/acme/repo/milestone/0', '/acme/repo/milestone/x/edit', '/acme/repo/milestone/3/close']) {
    expect(isSpaRoute(p), p).toBe(false);
  }
  // The classic page asked for by name, and an owner's profile tabs, are classic.
  expect(isSpaRoute('/acme/repo/issues', '?ui=classic')).toBe(false);
  expect(isSpaRoute('/acme', '?tab=activity')).toBe(false);
  expect(isSpaRoute('/acme', '?tab=repositories&q=x')).toBe(true);
  // A wiki page's revisions are classic; its other ?action= views are the app's.
  expect(isSpaRoute('/acme/repo/wiki/Home', '?action=_revision')).toBe(false);
  expect(isSpaRoute('/acme/repo/wiki/', '?action=_pages')).toBe(true);
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
