// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {classicPathOf, isCanonical, nextPathOf, repoOfPath} from './paths.ts';

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
  expect(nextPathOf('/dev')).toBe('/-/next/dev');
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
  for (const p of ['/', '/issues', '/acme/atlas', '/acme/atlas/pulls/3']) expect(isCanonical(p), p).toBe(true);
  for (const p of ['/explore', '/acme', '/user/login', '/acme/atlas/settings', '/acme/atlas/issues/new']) expect(isCanonical(p), p).toBe(false);
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
});
