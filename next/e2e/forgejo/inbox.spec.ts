// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, apiJson, newIssue, ok, seed} from '../lib/api.ts';
import {signIn} from '../lib/app.ts';
import {aliceAuth, BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

test('unsubscribe two inbox threads offline, sync, and undo their read state', async ({page, context}) => {
  const repo = 'inbox-unsubscribe';
  seed(repo, 2);
  const titles = [0, 1].map((i) => `Inbox unsubscribe ${String(Date.now())}-${String(i)}`);
  const issues = [];
  for (const title of titles) {
    const issue = await newIssue(USER, repo, title);
    issues.push(issue);
    await ok(await api('PUT', `/repos/${USER}/${repo}/issues/${String(issue.number)}/subscriptions/${USER}`), 'subscribe');
    await ok(await api('POST', `/repos/${USER}/${repo}/issues/${String(issue.number)}/comments`, {body: 'Inbox activity'}, aliceAuth), 'notify');
  }
  await signIn(page);
  await page.goto(`${BASE}/notifications?filter=all`);
  const list = page.getByRole('listbox', {name: 'Notifications'});
  const rows = titles.map((title) => list.getByRole('option').filter({hasText: title}));
  for (const row of rows) await expect(row).toBeVisible({timeout: 60_000});
  const first = rows.at(0);
  if (!first) throw new Error('No notification fixtures');
  await first.click({button: 'right'});
  await page.keyboard.press('Escape');
  await list.focus();
  await page.keyboard.press('x');
  const second = rows.at(1);
  if (!second) throw new Error('Missing second notification');
  await second.click({button: 'right'});
  await page.keyboard.press('Escape');
  await list.focus();
  await page.keyboard.press('x');
  await context.setOffline(true);
  try {
    await first.click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Unsubscribe and mark read (2)', exact: true}).click();
    for (const row of rows) await expect(row).not.toContainText('Unread:');
  } finally {
    await context.setOffline(false);
  }
  // The check answers 200 either way; its body says whether the user is subscribed.
  const subscribed = async (number: number) =>
    (await apiJson<{subscribed: boolean}>('GET', `/repos/${USER}/${repo}/issues/${String(number)}/subscriptions/check`)).subscribed;
  for (const issue of issues) await expect.poll(() => subscribed(issue.number), {timeout: 60_000}).toBe(false);
  await page.getByRole('button', {name: 'Undo', exact: true}).click();
  for (const row of rows) await expect(row).toContainText('Unread:');
  for (const issue of issues) await expect.poll(() => subscribed(issue.number), {timeout: 60_000}).toBe(true);
});
