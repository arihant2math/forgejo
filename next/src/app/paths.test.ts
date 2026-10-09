// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {appPageOf, classicOfLocation, classicPathOf, isCanonical, nextPathOf, repoOfPath} from './paths.ts';

test('classic links → the app\'s pages', () => {
  expect(nextPathOf('/')).toBe('/');
  expect(nextPathOf('/notifications')).toBe('/notifications');
  expect(nextPathOf('/acme/atlas')).toBe('/acme/atlas');
  expect(nextPathOf('/acme/atlas/issues/12')).toBe('/acme/atlas/issues/12');
  expect(nextPathOf('/acme/atlas/pulls/9/files')).toBe('/acme/atlas/pulls/9?tab=files');
  expect(nextPathOf('/acme/atlas/src/branch/main/docs/a b.md')).toBe('/-/next/code/acme/atlas/src/branch/main/docs/a%20b.md/-');
  expect(nextPathOf('/acme/atlas/commit/' + 'a'.repeat(40))).toBe(`/-/next/code/acme/atlas/commit/${'a'.repeat(40)}/-`);
  expect(nextPathOf('/acme/atlas/actions/runs/3')).toBe('/-/next/code/acme/atlas/actions/runs/3/-');
  expect(nextPathOf('/acme/atlas/projects/1')).toBe('/-/next/projects/1');
  expect(nextPathOf('/acme/-/projects/3')).toBe('/-/next/projects/3');
  expect(nextPathOf('/dev')).toBe('/dev');
  expect(nextPathOf('/acme/atlas/actions/runs/3/jobs/0/attempt/1')).toBe('/-/next/code/acme/atlas/actions/runs/3/jobs/0/attempt/1/-');
  // Forgejo's own pages and what the app does not render stay classic.
  for (const p of ['/explore', '/user/settings', '/acme/atlas/settings', '/acme/atlas/wiki', '/acme/atlas/issues/new', '/api/v1/repos', '/acme/atlas/src/x%2f..', '/-/next/']) {
    expect(nextPathOf(p), p).toBeUndefined();
  }
});

test('the app\'s pages → classic pages', () => {
  expect(classicPathOf('/acme/atlas/issues/3')).toBe('/acme/atlas/issues/3');
  expect(classicPathOf('/-/next/code/acme/atlas/src/branch/main/README.md/-')).toBe('/acme/atlas/src/branch/main/README.md');
  expect(classicPathOf('/-/next/code/acme/atlas/-')).toBe('/acme/atlas');
  expect(classicPathOf('/-/next/projects/1', {board: () => ({repo: 'acme/atlas'})})).toBe('/acme/atlas/projects/1');
  expect(classicPathOf('/-/next/projects/3', {board: () => ({owner: 'acme'})})).toBe('/acme/-/projects/3');
  expect(classicPathOf('/-/next/boards', {login: 'dev'})).toBe('/dev/-/projects');
  expect(classicPathOf('/-/next/acme')).toBe('/acme');
  expect(classicPathOf('/-/next/')).toBe('/');
});

test('canonical routes and the repository of a route', () => {
  for (const p of ['/', '/issues', '/acme', '/acme/atlas', '/acme/atlas/pulls/3']) expect(isCanonical(p), p).toBe(true);
  for (const p of ['/explore', '/dev.keys', '/user/login', '/acme/atlas/settings', '/acme/atlas/issues/new']) expect(isCanonical(p), p).toBe(false);
  expect(isCanonical('/acme', '?tab=activity')).toBe(false);
  expect(isCanonical('/acme/atlas', '?ui=classic')).toBe(false);
  expect(repoOfPath('/acme/Atlas/issues/3')).toBe('acme/atlas');
  expect(repoOfPath('/-/next/code/acme/atlas/src/-')).toBe('acme/atlas');
  expect(repoOfPath('/notifications')).toBeUndefined();
  expect(repoOfPath('/user/settings')).toBeUndefined();
});

test('missing-content sentences agree with their subject', async () => {
  const {missingWords} = await import('./Missing.tsx');
  expect(missingWords('These commits').offline).toBe('These commits are not on this device. Connect to load them, or open one of these:');
  expect(missingWords('This file').offline).toBe('This file is not on this device. Connect to load it, or open one of these:');
  expect(missingWords('These changes').notFound).toBe('These changes do not exist, or you cannot see them.');
  expect(missingWords('Its description and comments').offline).toBe('Its description and comments are not on this device. Connect to load them, or open one of these:');
  expect(missingWords('This repository\'s files').offline).toMatch(/^This repository's files are not/);
  expect(missingWords('This pull request\'s changes').notFound).toBe('This pull request\'s changes do not exist, or you cannot see them.');
  expect(missingWords('This repository').notFound).toBe('This repository does not exist, or you cannot see it.');
});

test('classic pages\' way back to the app: the app\'s page for the address, else Home', () => {
  expect(appPageOf('/acme/atlas/projects/1')).toBe('/-/next/projects/1');
  expect(appPageOf('/acme/-/projects/3')).toBe('/-/next/projects/3');
  expect(appPageOf('/acme/atlas/pulls/91/files')).toBe('/acme/atlas/pulls/91?tab=files');
  expect(appPageOf('/acme')).toBe('/acme');
  expect(appPageOf('/acme?tab=activity')).toBe('/acme');
  expect(appPageOf('/acme/atlas/issues?state=closed&labels=3')).toBe('/acme/atlas/issues?state=closed&labels=3');
  expect(appPageOf('/acme/atlas/actions/runs/3/jobs/0/attempt/1')).toBe('/-/next/code/acme/atlas/actions/runs/3/jobs/0/attempt/1/-');
  for (const p of ['/explore/repos', '/user/settings', '//evil.example/x', 'https://evil.example/']) expect(appPageOf(p), p).toBe('/');
  // A repository's classic-only pages: the nearest page of the app, never Home.
  for (const p of ['/acme/atlas/settings', '/acme/atlas/milestones', '/acme/atlas/wiki/Home', '/acme/atlas/activity', '/acme/atlas/stars', '/acme/atlas/labels']) {
    expect(appPageOf(p), p).toBe('/acme/atlas');
  }
  expect(appPageOf('/acme/atlas/releases/tag/v0.2.0')).toBe('/-/next/code/acme/atlas/releases/-');
  expect(appPageOf('/acme/atlas/projects')).toBe('/-/next/boards');
  expect(appPageOf('/acme/atlas/issues/new')).toBe('/acme/atlas/issues');
});

test('"This page" in the classic UI keeps the list\'s query', () => {
  expect(classicOfLocation('/issues', '?type=assigned')).toBe('/issues?type=assigned');
  expect(classicOfLocation('/acme/atlas/issues', 'state=closed')).toBe('/acme/atlas/issues?state=closed');
  expect(classicOfLocation('/notifications', '?filter=unread')).toBe('/notifications?filter=unread');
  expect(classicOfLocation('/-/next/code/acme/atlas/src/-', '?x=1')).toBe('/acme/atlas');
  const ctx = {defaultBranch: () => 'main'};
  expect(classicOfLocation('/-/next/code/acme/atlas/src/-', '', ctx)).toBe('/acme/atlas/src/branch/main');
  expect(classicOfLocation('/-/next/code/acme/atlas/commits/-', '', ctx)).toBe('/acme/atlas/commits/branch/main');
  expect(classicOfLocation('/-/next/code/acme/atlas/src/docs/-', '', ctx)).toBe('/acme/atlas/src/branch/main/docs');
  expect(classicOfLocation('/-/next/code/acme/atlas/src/tag/v1/-', '', ctx)).toBe('/acme/atlas/src/tag/v1');
  expect(classicOfLocation('/-/next/code/acme/atlas/branches/-', '', ctx)).toBe('/acme/atlas/branches');
  // A pull request's tab is its own path in the classic UI.
  expect(classicOfLocation('/acme/atlas/pulls/91', '?tab=files')).toBe('/acme/atlas/pulls/91/files');
  expect(classicOfLocation('/acme/atlas/pulls/91', '?tab=commits')).toBe('/acme/atlas/pulls/91/commits');
  expect(classicOfLocation('/acme/atlas/pulls/91', '?tab=checks')).toBe('/acme/atlas/pulls/91');
});
