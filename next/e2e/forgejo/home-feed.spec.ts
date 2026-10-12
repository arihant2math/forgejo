// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, apiJson, ensureUser, newIssue, ok} from '../lib/api.ts';
import {issueTitle, signIn, watch} from '../lib/app.ts';
import {ALICE, aliceAuth, BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
const repo = `home-feed-${Date.now().toString(36)}`;
let number: number;

test.beforeAll(async () => {
  await ensureUser(ALICE.user);
  await ok(await api('POST', '/user/repos', {name: repo, private: true}), 'create private repo');
  await ok(await api('PUT', `/repos/${USER}/${repo}/collaborators/${ALICE.user}`, {permission: 'write'}), 'add collaborator');
  number = (await newIssue(USER, repo, 'Activity from another person', '', aliceAuth)).number;
  // Forgejo records feed actions from a queue: wait until the feed has it (the page asks once, as GitHub's does).
  await expect.poll(async () => (await apiJson<{op_type: string; repo: {name: string}}[]>('GET', `/users/${USER}/activities/feeds?limit=20`))
    .some((a) => a.op_type === 'create_issue' && a.repo.name === repo), {timeout: 30_000}).toBe(true);
});
test.afterAll(async () => { await api('DELETE', `/repos/${USER}/${repo}`); });

test('another person’s activity opens in-app and the last page remains offline', async ({page, context}) => {
  const problems = watch(page);
  await signIn(page);
  await page.goto(BASE);
  const feed = page.getByRole('region', {name: 'Activity'});
  const link = feed.getByRole('link', {name: /alice opened an issue in .*Activity from another person/});
  await expect(link).toBeVisible({timeout: 30_000});
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/${USER}/${repo}/issues/${String(number)}$`));
  await expect(issueTitle(page)).toContainText('Activity from another person');
  await page.goBack();
  await expect(link).toBeVisible();
  await context.setOffline(true);
  await expect(feed.getByText(/Offline · last fetched/)).toBeVisible();
  await expect(link).toBeVisible();
  await expect(feed.getByRole('button', {name: 'Load more'})).toHaveCount(0);
  await context.setOffline(false);
  expect(problems).toEqual([]);
});
