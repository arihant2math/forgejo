// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {appPageOf, classicOfLocation, classicPathOf, isCanonical, isListPath, nextPathOf, repoOfPath} from './paths.ts';

test('classic links → the app\'s pages', () => {
  expect(nextPathOf('/')).toBe('/');
  expect(nextPathOf('/notifications')).toBe('/notifications');
  expect(nextPathOf('/acme/atlas')).toBe('/acme/atlas');
  expect(nextPathOf('/acme/atlas/issues/12')).toBe('/acme/atlas/issues/12');
  expect(nextPathOf('/acme/atlas/pulls/9/files')).toBe('/acme/atlas/pulls/9?tab=files');
  expect(nextPathOf('/acme/atlas/src/branch/main/docs/a b.md')).toBe('/-/next/code/acme/atlas/src/branch/main/docs/a%20b.md/-');
  expect(nextPathOf('/acme/atlas/commit/' + 'a'.repeat(40))).toBe(`/-/next/code/acme/atlas/commit/${'a'.repeat(40)}/-`);
  expect(nextPathOf('/acme/atlas/releases/new')).toBe('/-/next/code/acme/atlas/releases/new/-');
  expect(nextPathOf('/acme/atlas/releases/edit/release/1.0')).toBe('/-/next/code/acme/atlas/releases/edit/release/1.0/-');
  expect(classicPathOf('/-/next/code/acme/atlas/releases/edit/v1.2/-')).toBe('/acme/atlas/releases/edit/v1.2');
  expect(nextPathOf('/acme/atlas/actions/runs/3')).toBe('/-/next/code/acme/atlas/actions/runs/3/-');
  expect(nextPathOf('/acme/atlas/projects/1')).toBe('/-/next/projects/1');
  expect(nextPathOf('/acme/-/projects/3')).toBe('/-/next/projects/3');
  // An abbreviated SHA: the code view resolves it.
  expect(nextPathOf('/acme/atlas/commit/7af171c9e8')).toBe('/-/next/code/acme/atlas/commit/7af171c9e8/-');
  expect(nextPathOf('/acme/atlas/commit/7af171')).toBeUndefined();
  expect(nextPathOf('/dev')).toBe('/dev');
  expect(nextPathOf('/acme/atlas/actions/runs/3/jobs/0/attempt/1')).toBe('/-/next/code/acme/atlas/actions/runs/3/jobs/0/attempt/1/-');
  // The wiki: its pages and views (the page list, a new page, an editor).
  expect(nextPathOf('/acme/atlas/wiki')).toBe('/acme/atlas/wiki');
  expect(nextPathOf('/acme/atlas/wiki/')).toBe('/acme/atlas/wiki');
  expect(nextPathOf('/acme/atlas/wiki/C%2B%2B')).toBe('/acme/atlas/wiki/C%2B%2B');
  expect(nextPathOf('/acme/atlas/wiki/-/pages')).toBe('/acme/atlas/wiki/-/pages');
  expect(nextPathOf('/acme/atlas/wiki/Home/-/edit')).toBe('/acme/atlas/wiki/Home/-/edit');
  // A comparison (where a pull request is opened), with the default branch left out or no head yet.
  expect(nextPathOf('/acme/atlas/compare/main...feature/x')).toBe('/-/next/code/acme/atlas/compare/main...feature/x/-');
  expect(nextPathOf('/acme/atlas/compare/feature')).toBe('/-/next/code/acme/atlas/compare/feature/-');
  expect(nextPathOf('/acme/atlas/compare')).toBe('/-/next/code/acme/atlas/compare/-');
  expect(nextPathOf('/acme/atlas/compare/main..feature')).toBeUndefined();
  // The new repository and organization forms ("repo" and "org" are reserved names: no owner); a migration stays classic.
  expect(nextPathOf('/repo/create')).toBe('/repo/create');
  expect(nextPathOf('/org/create')).toBe('/org/create');
  expect(appPageOf('/repo/create?org=3')).toBe('/repo/create?org=3');
  expect(appPageOf('/org/create?x=1')).toBe('/org/create');
  // Labels and milestones.
  expect(nextPathOf('/acme/atlas/labels')).toBe('/acme/atlas/labels');
  expect(nextPathOf('/acme/atlas/milestones')).toBe('/acme/atlas/milestones');
  expect(nextPathOf('/acme/atlas/milestones/new')).toBe('/acme/atlas/milestones/new');
  expect(nextPathOf('/acme/atlas/milestone/7')).toBe('/acme/atlas/milestone/7');
  expect(nextPathOf('/acme/atlas/milestone/7/edit')).toBe('/acme/atlas/milestone/7/edit');
  for (const p of ['/acme/atlas/labels/x', '/acme/atlas/milestone/0', '/acme/atlas/milestone/7/close', '/acme/atlas/milestones/7']) expect(nextPathOf(p), p).toBeUndefined();
  // Forgejo's own pages and what the app does not render stay classic.
  // Settings: the sections the app has.
  expect(nextPathOf('/acme/atlas/settings')).toBe('/acme/atlas/settings');
  expect(nextPathOf('/acme/atlas/settings/hooks')).toBe('/acme/atlas/settings/hooks');
  expect(nextPathOf('/acme/atlas/settings/collaboration')).toBe('/acme/atlas/settings/collaboration');
  // The viewer's settings: the app's pages, the others classic.
  expect(nextPathOf('/user/settings')).toBe('/user/settings');
  expect(nextPathOf('/user/settings/')).toBe('/user/settings');
  expect(nextPathOf('/user/settings/keys')).toBe('/user/settings/keys');
  expect(nextPathOf('/user/settings/account')).toBe('/user/settings/account');
  for (const p of ['/user/settings/applications', '/user/settings/keys/x', '/user/login', '/user']) expect(nextPathOf(p), p).toBeUndefined();
  for (const p of ['/explore', '/repo/migrate', '/org/acme/teams', '/repo/create/x', '/acme/atlas/settings/units', '/acme/atlas/settings/hooks/3', '/acme/atlas/settings/hooks/git', '/acme/atlas/wiki/raw/logo.png', '/acme/atlas/wiki/search', '/acme/atlas/wiki/a%2Fb', '/acme/atlas/issues/new', '/api/v1/repos', '/acme/atlas/src/x%2f..', '/-/next/']) {
    expect(nextPathOf(p), p).toBeUndefined();
  }
});

test('the app\'s pages → classic pages', () => {
  expect(classicPathOf('/acme/atlas/issues/3')).toBe('/acme/atlas/issues/3');
  expect(classicPathOf('/-/next/code/acme/atlas/src/branch/main/README.md/-')).toBe('/acme/atlas/src/branch/main/README.md');
  expect(classicPathOf('/-/next/code/acme/atlas/-')).toBe('/acme/atlas');
  expect(classicPathOf('/-/next/code/acme/atlas/compare/-')).toBe('/acme/atlas/compare');
  expect(classicPathOf('/-/next/code/acme/atlas/compare/main...feature/x/-')).toBe('/acme/atlas/compare/main...feature/x');
  expect(classicPathOf('/-/next/projects/1', {board: () => ({repo: 'acme/atlas'})})).toBe('/acme/atlas/projects/1');
  expect(classicPathOf('/-/next/projects/3', {board: () => ({owner: 'acme'})})).toBe('/acme/-/projects/3');
  expect(classicPathOf('/-/next/boards', {login: 'dev'})).toBe('/dev/-/projects');
  expect(classicPathOf('/-/next/acme')).toBe('/acme');
  expect(classicPathOf('/-/next/')).toBe('/');
  // The wiki's own views are the classic wiki's ?action=.
  expect(classicPathOf('/acme/atlas/wiki/Home')).toBe('/acme/atlas/wiki/Home');
  expect(classicPathOf('/acme/atlas/wiki/-/pages')).toBe('/acme/atlas/wiki/?action=_pages');
  expect(classicPathOf('/acme/atlas/wiki/-/new')).toBe('/acme/atlas/wiki/?action=_new');
  expect(classicPathOf('/acme/atlas/wiki/Home/-/edit')).toBe('/acme/atlas/wiki/Home?action=_edit');
  expect(classicOfLocation('/acme/atlas/wiki/-/new', '?title=Home')).toBe('/acme/atlas/wiki/?action=_new');
});

test('canonical routes and the repository of a route', () => {
  for (const p of ['/', '/issues', '/acme', '/acme/atlas', '/acme/atlas/pulls/3', '/acme/atlas/wiki', '/acme/atlas/wiki/Home', '/acme/atlas/wiki/-/pages', '/user/settings', '/user/settings/keys']) expect(isCanonical(p), p).toBe(true);
  for (const p of ['/acme/atlas/settings', '/acme/atlas/settings/branches', '/acme/atlas/settings/keys']) expect(isCanonical(p), p).toBe(true);
  expect(isCanonical('/acme/atlas/wiki/Home', '?action=_revision')).toBe(false);
  expect(repoOfPath('/acme/atlas/wiki/Home')).toBe('acme/atlas');
  for (const p of ['/explore', '/dev.keys', '/user/login', '/acme/atlas/settings/units', '/acme/atlas/settings/hooks/git']) expect(isCanonical(p), p).toBe(false);
  expect(isCanonical('/acme/atlas/issues/new')).toBe(true);
  expect(isCanonical('/acme', '?tab=activity')).toBe(false);
  expect(isCanonical('/acme/atlas', '?ui=classic')).toBe(false);
  expect(repoOfPath('/acme/Atlas/issues/3')).toBe('acme/atlas');
  expect(repoOfPath('/-/next/code/acme/atlas/src/-')).toBe('acme/atlas');
  expect(repoOfPath('/acme/atlas/activity/monthly')).toBe('acme/atlas');
  expect(repoOfPath('/acme/atlas/milestone/2')).toBe('acme/atlas');
  expect(repoOfPath('/acme/atlas/labels')).toBe('acme/atlas');
  expect(isListPath('/acme/atlas/milestone/2')).toBe(true);
  expect(isListPath('/acme/atlas/milestones')).toBe(false);
  expect(repoOfPath('/notifications')).toBeUndefined();
  expect(repoOfPath('/user/settings')).toBeUndefined();
  expect(repoOfPath('/acme/atlas/settings/hooks')).toBe('acme/atlas');
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
  expect(appPageOf('/acme/-/projects')).toBe('/-/next/boards');
  expect(appPageOf('/dev/-/projects')).toBe('/-/next/boards');
  expect(appPageOf('/acme/atlas/pulls/91/files')).toBe('/acme/atlas/pulls/91?tab=files');
  expect(appPageOf('/acme')).toBe('/acme');
  expect(appPageOf('/acme?tab=activity')).toBe('/acme');
  expect(appPageOf('/acme/atlas/issues?state=closed&labels=3')).toBe('/acme/atlas/issues?state=closed&labels=3');
  expect(appPageOf('/acme/atlas/actions/runs/3/jobs/0/attempt/1')).toBe('/-/next/code/acme/atlas/actions/runs/3/jobs/0/attempt/1/-');
  for (const p of ['/explore/repos', '/user/login', '//evil.example/x', 'https://evil.example/']) expect(appPageOf(p), p).toBe('/');
  // The settings: the app's page, or its settings for a page it has not.
  expect(appPageOf('/user/settings/appearance')).toBe('/user/settings/appearance');
  expect(appPageOf('/user/settings/applications')).toBe('/user/settings');
  expect(appPageOf('/user/settings/security?x=1')).toBe('/user/settings');
  // A repository's classic-only pages: the nearest page of the app, never Home.
  for (const p of ['/acme/atlas/activity_author_data', '/acme/atlas/stars']) {
    expect(appPageOf(p), p).toBe('/acme/atlas');
  }
  // The wiki: its page; the classic wiki's ?action= views; what the app has not, the wiki's Home.
  expect(appPageOf('/acme/atlas/wiki/Home')).toBe('/acme/atlas/wiki/Home');
  expect(appPageOf('/acme/atlas/wiki/?action=_pages')).toBe('/acme/atlas/wiki/-/pages');
  expect(appPageOf('/acme/atlas/wiki?action=_new')).toBe('/acme/atlas/wiki/-/new');
  expect(appPageOf('/acme/atlas/wiki/Home?action=_edit')).toBe('/acme/atlas/wiki/Home/-/edit');
  expect(appPageOf('/acme/atlas/wiki/Home?action=_revision')).toBe('/acme/atlas/wiki/Home');
  expect(appPageOf('/acme/atlas/wiki/raw/logo.png')).toBe('/acme/atlas/wiki');
  // Labels and milestones are the app's pages; their other classic addresses the nearest one.
  expect(appPageOf('/acme/atlas/labels')).toBe('/acme/atlas/labels');
  expect(appPageOf('/acme/atlas/milestones?state=closed')).toBe('/acme/atlas/milestones?state=closed');
  expect(appPageOf('/acme/atlas/milestones/new?x=1')).toBe('/acme/atlas/milestones/new');
  expect(appPageOf('/acme/atlas/milestone/4?state=closed')).toBe('/acme/atlas/milestone/4?state=closed');
  expect(appPageOf('/acme/atlas/milestone/4/edit')).toBe('/acme/atlas/milestone/4/edit');
  expect(appPageOf('/acme/atlas/milestones/new')).toBe('/acme/atlas/milestones/new');
  expect(appPageOf('/acme/atlas/milestone/4/close')).toBe('/acme/atlas/milestones');
  expect(appPageOf('/acme/atlas/labels/edit')).toBe('/acme/atlas/labels');
  expect(appPageOf('/acme/atlas/releases/tag/v0.2.0')).toBe('/-/next/code/acme/atlas/releases/-');
  expect(appPageOf('/acme/atlas/projects')).toBe('/-/next/boards');
  // A settings section only the classic UI has: the app's settings.
  expect(appPageOf('/acme/atlas/settings/units')).toBe('/acme/atlas/settings');
  expect(appPageOf('/acme/atlas/settings/actions/secrets')).toBe('/acme/atlas/settings');
  expect(appPageOf('/acme/atlas/settings/keys')).toBe('/acme/atlas/settings/keys');
  // The activity pages are the app's.
  expect(appPageOf('/acme/atlas/activity')).toBe('/acme/atlas/activity');
  expect(appPageOf('/acme/atlas/activity/monthly')).toBe('/acme/atlas/activity/monthly');
  expect(appPageOf('/acme/atlas/activity/code-frequency')).toBe('/acme/atlas/activity/code-frequency');
  expect(appPageOf('/acme/atlas/activity/hourly')).toBe('/acme/atlas');
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
