// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's activity against a real Forgejo: the Pulse counted from the
// synced pool (issues opened and closed, a merged and an open pull request, a
// release), the period switched in the app and offline, the commits and top
// committers from the history by commit, and the contributor graphs.

import {expect, test} from '@playwright/test';
import {api, b64, newIssue, ok} from '../lib/api.ts';
import {signIn, watch} from '../lib/app.ts';
import {changeFiles} from '../lib/code.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

const RUN = Date.now().toString(36);
const REPO = `act-${RUN}`;

test.beforeAll(async () => {
  test.setTimeout(3 * 60_000);
  await ok(await api('POST', '/user/repos', {name: REPO, auto_init: true, default_branch: 'main'}), 'create repo');
  await newIssue(USER, REPO, 'Still open');
  const closed = await newIssue(USER, REPO, 'Closed again');
  await ok(await api('PATCH', `/repos/${USER}/${REPO}/issues/${String(closed.number)}`, {state: 'closed'}), 'close');
  // A pull request merged and one left open.
  await changeFiles(REPO, {branch: 'main', new_branch: 'merged', message: 'To be merged', files: [{operation: 'create', path: 'a.txt', content: b64('a\nb\n')}]});
  const merged = await (await ok(await api('POST', `/repos/${USER}/${REPO}/pulls`, {head: 'merged', base: 'main', title: 'Merged change'}), 'pull')).json() as {number: number};
  await ok(await api('POST', `/repos/${USER}/${REPO}/pulls/${String(merged.number)}/merge`, {Do: 'merge'}), 'merge');
  await changeFiles(REPO, {branch: 'main', new_branch: 'open', message: 'Still proposed', files: [{operation: 'create', path: 'b.txt', content: b64('b\n')}]});
  await ok(await api('POST', `/repos/${USER}/${REPO}/pulls`, {head: 'open', base: 'main', title: 'Open change'}), 'open pull');
  await ok(await api('POST', `/repos/${USER}/${REPO}/releases`, {tag_name: 'v1.0.0', name: 'First release', target_commitish: 'main'}), 'release');
});

test.afterAll(async () => {
  await api('DELETE', `/repos/${USER}/${REPO}`);
});

test('the Pulse counts from the pool, switches period in place (offline too), and links the graphs', async ({page, context}) => {
  const problems = watch(page);
  await signIn(page);
  await page.goto(`${BASE}/${USER}/${REPO}`);
  // The Activity tab is the app's page.
  const tabs = page.getByRole('navigation', {name: 'Repository'});
  await tabs.getByRole('link', {name: 'Activity'}).click();
  await expect(page).toHaveURL(new RegExp(`/${USER}/${REPO}/activity$`));
  await expect(tabs.getByRole('link', {name: 'Activity'})).toHaveAttribute('aria-current', 'page');
  const overview = page.getByRole('region', {name: 'Overview'});
  await expect(overview.getByText('2 active pull requests')).toBeVisible({timeout: 20_000});
  await expect(overview.getByText('2 active issues')).toBeVisible();
  await expect(overview.getByRole('link', {name: /1\s*merged pull request/})).toBeVisible();
  await expect(overview.getByRole('link', {name: /1\s*open pull request/})).toBeVisible();
  await expect(overview.getByRole('link', {name: /1\s*closed issue/})).toBeVisible();
  await expect(overview.getByRole('link', {name: /2\s*new issues/})).toBeVisible();
  await expect(page.getByRole('region', {name: 'Releases'}).getByText('First release')).toBeVisible();
  await expect(page.getByRole('region', {name: 'merged pull requests'}).getByText('Merged change')).toBeVisible();
  // The history by commit: the commits of the week and who made them.
  const commits = page.getByRole('region', {name: 'Commits'});
  await expect(commits.getByText(/Excluding merges, 1 author has pushed \d+ commits? to main/)).toBeVisible({timeout: 20_000});
  await expect(commits.getByRole('link', {name: USER})).toBeVisible();

  // Another period: in the app, from the same rows, and offline as well.
  await page.getByRole('button', {name: 'Period: 1 week'}).click();
  await page.getByRole('menuitemradio', {name: '1 month'}).click();
  await expect(page).toHaveURL(/\/activity\/monthly$/);
  await expect(overview.getByText('2 active issues')).toBeVisible();
  await context.setOffline(true);
  await page.getByRole('button', {name: 'Period: 1 month'}).click();
  await page.getByRole('menuitemradio', {name: '1 day'}).click();
  await expect(page).toHaveURL(/\/activity\/daily$/);
  await expect(overview.getByText('2 active pull requests')).toBeVisible();
  await expect(commits.getByText(/Excluding merges, 1 author/)).toBeVisible();
  await context.setOffline(false);

  // The graphs: computed by Forgejo in the background, then drawn.
  const pages = page.getByRole('navigation', {name: 'Activity pages'});
  await pages.getByRole('link', {name: 'Contributors'}).click();
  await expect(page).toHaveURL(/\/activity\/contributors$/);
  await expect(page.getByRole('img', {name: 'Commits per week to main'})).toBeVisible({timeout: 30_000});
  await expect(page.getByRole('img', {name: new RegExp(`^Commits per week by `)}).first()).toBeVisible();
  await pages.getByRole('link', {name: 'Code frequency'}).click();
  await expect(page.getByRole('img', {name: 'Lines added and deleted per week on main'})).toBeVisible();
  await pages.getByRole('link', {name: 'Recent commits'}).click();
  await expect(page.getByRole('img', {name: 'Commits per week to main in the last 52 weeks'})).toBeVisible();
  // A reload stays in the app (spaRoutes).
  await page.reload();
  await expect(page.getByRole('img', {name: 'Commits per week to main in the last 52 weeks'})).toBeVisible({timeout: 20_000});
  expect(problems).toEqual([]);
});
