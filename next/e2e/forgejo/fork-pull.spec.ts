// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {expect, test} from '@playwright/test';
import {api, apiJson, b64, ok} from '../lib/api.ts';
import {signIn} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

test('contribute from a fork and toggle maintainer edits in the sidebar', async ({page}) => {
  const upstream = `fork-pr-source-${Date.now().toString(36)}`;
  const fork = `${upstream}-fork`;
  await ok(await api('POST', '/user/repos', {name: upstream, auto_init: true, default_branch: 'main'}), 'seed upstream');
  try {
    await signIn(page);
    await page.goto(`${BASE}/${USER}/${upstream}`);
    await page.getByRole('button', {name: /^Fork ·/}).click();
    const dialog = page.getByRole('dialog', {name: 'Create a new fork'});
    await dialog.getByRole('textbox', {name: 'Repository name'}).fill(fork);
    await expect(dialog.getByText(`${fork} is available.`)).toBeVisible();
    await dialog.getByRole('button', {name: 'Create fork', exact: true}).click();
    await expect(page).toHaveURL(`${BASE}/${USER}/${fork}`, {timeout: 30_000});
    // API content commits are the pushed-branch fixture; no local Git credentials required.
    await ok(await api('POST', `/repos/${USER}/${fork}/contents/contribution.txt`, {branch: 'main', content: b64('From the fork\n'), message: 'Contribute from fork'}), 'push fork commit');
    await page.reload();
    await page.getByRole('link', {name: 'Compare & open pull request'}).click();
    await expect(page.getByRole('textbox', {name: 'Title'})).toHaveValue('Contribute from fork');
    await expect(page.getByRole('checkbox', {name: 'Allow edits by maintainers'})).toBeChecked();
    await page.getByRole('button', {name: 'Create pull request', exact: true}).click();
    await expect(page).toHaveURL(new RegExp(`/${USER}/${upstream}/pulls/\\d+`));
    const pulls = await apiJson<{number: number; allow_maintainer_edit: boolean; head: {repo: {name: string}}}[]>('GET', `/repos/${USER}/${upstream}/pulls?state=open`);
    expect(pulls[0]?.head.repo.name).toBe(fork);
    expect(pulls[0]?.allow_maintainer_edit).toBe(true);
    await page.getByRole('checkbox', {name: 'Allow edits by maintainers'}).uncheck();
    await expect.poll(async () => (await apiJson<{allow_maintainer_edit: boolean}>('GET', `/repos/${USER}/${upstream}/pulls/${String(pulls[0]?.number)}`)).allow_maintainer_edit).toBe(false);
  } finally {
    await api('DELETE', `/repos/${USER}/${fork}`);
    await api('DELETE', `/repos/${USER}/${upstream}`);
  }
});
