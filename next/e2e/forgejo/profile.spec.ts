// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, ensureUser, newIssue, ok} from '../lib/api.ts';
import {signIn, watch} from '../lib/app.ts';
import {ALICE, aliceAuth, BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
const repo = `profile-${Date.now().toString(36)}`;
let number: number;
test.beforeAll(async () => {
  await ensureUser(ALICE.user);
  await ok(await api('POST', '/user/repos', {name: repo}), 'create repo');
  await ok(await api('PUT', `/repos/${USER}/${repo}/collaborators/${ALICE.user}`, {permission: 'write'}), 'add collaborator');
  await ok(await api('PUT', `/user/starred/${USER}/${repo}`, undefined, aliceAuth), 'star repo');
  await api('DELETE', `/user/following/${ALICE.user}`);
  number = (await newIssue(USER, repo, 'Profile click-through', '', aliceAuth)).number;
});
test.afterAll(async () => {
  await api('DELETE', `/user/following/${ALICE.user}`);
  await api('DELETE', `/repos/${USER}/${repo}`);
});
test('issue avatar opens the profile, follow works, and stars open repositories', async ({page}) => {
  const problems = watch(page);
  await signIn(page);
  await page.goto(`${BASE}/${USER}/${repo}/issues/${String(number)}`);
  await page.getByRole('link', {name: `Profile of ${ALICE.user}`}).first().click();
  await expect(page.getByRole('link', {name: 'Overview', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Follow', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Unfollow', exact: true})).toBeEnabled();
  await page.getByRole('link', {name: 'Stars', exact: true}).click();
  await page.getByRole('link', {name: new RegExp(`${USER}/${repo}`)}).click();
  await expect(page).toHaveURL(new RegExp(`/${USER}/${repo}$`));
  expect(problems).toEqual([]);
});
