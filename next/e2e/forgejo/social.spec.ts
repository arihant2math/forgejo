// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, ensureUser, newIssue, ok} from '../lib/api.ts';
import {signedIn} from '../lib/app.ts';
import {ALICE, aliceAuth, BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
const REPO = `social-${String(Date.now())}`;
test.beforeAll(async () => {
  await ensureUser(ALICE.user);
  await ok(await api('POST', '/user/repos', {name: REPO, auto_init: true}), 'create repository');
  await ok(await api('DELETE', `/repos/${USER}/${REPO}/subscription`), 'initially unwatch');
});
test.afterAll(async () => { await api('DELETE', `/repos/${USER}/${REPO}`); });

test('star, watch, lists, and notifications from a second user', async ({browser}) => {
  const ctx = await browser.newContext();
  try {
    const page = await signedIn(ctx);
    await page.goto(`${BASE}/${USER}/${REPO}`);
    await page.getByRole('button', {name: /^Star\b/}).click();
    await expect.poll(async () => (await api('GET', `/user/starred/${USER}/${REPO}`)).status).toBe(204);
    await page.getByRole('button', {name: /^Watch\b/}).click();
    await page.getByRole('menuitemradio', {name: /^All Activity/}).click();
    await expect.poll(async () => (await api('GET', `/repos/${USER}/${REPO}/subscription`)).status).toBe(200);
    const issue = await newIssue(USER, REPO, `Watched activity ${REPO}`, '', aliceAuth);
    await page.goto(`${BASE}/notifications`);
    await expect(page.getByText(issue.title, {exact: true}).first()).toBeVisible({timeout: 30_000});
    await page.goto(`${BASE}/${USER}`);
    await page.getByRole('link', {name: /^Stars\b/}).click();
    await expect(page.getByRole('link', {name: `${USER}/${REPO}`, exact: false}).first()).toBeVisible();
    await page.getByRole('link', {name: 'Watching', exact: true}).click();
    await expect(page.getByRole('link', {name: `${USER}/${REPO}`, exact: false}).first()).toBeVisible();
    await page.goto(`${BASE}/${USER}/${REPO}`);
    await page.getByRole('button', {name: /^Starred\b/}).click();
    await expect.poll(async () => (await api('GET', `/user/starred/${USER}/${REPO}`)).status).toBe(404);
    await page.getByRole('button', {name: /^Unwatch\b/}).click();
    await expect(page.getByRole('menuitemradio', {name: /^All Activity/})).toBeChecked();
    await page.getByRole('menuitemradio', {name: /^Participating and @mentions/}).click();
    await expect.poll(async () => (await api('GET', `/repos/${USER}/${REPO}/subscription`)).status).toBe(404);
  } finally { await ctx.close(); }
});
