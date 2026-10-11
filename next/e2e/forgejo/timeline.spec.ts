// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, b64, ok} from '../lib/api.ts';
import {signIn} from '../lib/app.ts';
import {changeFiles} from '../lib/code.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

const repo = `timeline-${Date.now().toString(36)}`;

test.afterAll(async () => {
  await api('DELETE', `/repos/${USER}/${repo}`);
});

test('a commit keyword closes an issue and its timeline link opens the commit', async ({page}) => {
  await ok(await api('POST', '/user/repos', {name: repo, auto_init: true, default_branch: 'main'}), 'create repo');
  const issue = await (await ok(await api('POST', `/repos/${USER}/${repo}/issues`, {title: 'Close me with a commit'}), 'create issue')).json() as {number: number};
  const subject = `Fixes #${String(issue.number)}`;
  await changeFiles(repo, {branch: 'main', message: subject, files: [{operation: 'create', path: 'fix.txt', content: b64('fixed\n')}]});
  await expect.poll(async () => {
    const response = await ok(await api('GET', `/repos/${USER}/${repo}/issues/${String(issue.number)}`), 'issue state');
    return (await response.json() as {state: string}).state;
  }).toBe('closed');
  await signIn(page);
  await page.goto(`${BASE}/${USER}/${repo}/issues/${String(issue.number)}`);
  const event = page.getByText('closed this in', {exact: false});
  await expect(event).toBeVisible();
  const link = event.getByRole('link', {name: new RegExp(subject)});
  await link.click();
  await expect(page).toHaveURL(/\/[^/]+\/[^/]+\/commit\/[a-f0-9]{40}$/);
  await expect(page.getByText(subject, {exact: true}).first()).toBeVisible();
});
