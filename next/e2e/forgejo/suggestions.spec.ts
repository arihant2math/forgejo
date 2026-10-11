// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, b64, ok} from '../lib/api.ts';
import {signIn} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

test('write a line suggestion and commit it to the pull head', async ({page}) => {
  const repo = `suggestion-${Date.now().toString(36)}`;
  const path = `/repos/${USER}/${repo}`;
  await ok(await api('POST', '/user/repos', {name: repo, auto_init: true, default_branch: 'main'}), 'create repository');
  try {
    await ok(await api('POST', `${path}/contents/example.txt`, {branch: 'main', content: b64('before\n'), message: 'Add example'}), 'add file');
    await ok(await api('POST', `${path}/branches`, {new_branch_name: 'suggestion', old_branch_name: 'main'}), 'create head');
    const original = await (await ok(await api('GET', `${path}/contents/example.txt?ref=suggestion`), 'read file')).json() as {sha: string};
    await ok(await api('PUT', `${path}/contents/example.txt`, {branch: 'suggestion', sha: original.sha, content: b64('review me\n'), message: 'Change example'}), 'change file');
    const pull = await (await ok(await api('POST', `${path}/pulls`, {head: 'suggestion', base: 'main', title: 'Suggest a change'}), 'create pull')).json() as {number: number};
    await signIn(page);
    await page.goto(`${BASE}/${USER}/${repo}/pulls/${String(pull.number)}/files`);
    await page.getByRole('button', {name: 'Comment on line 1', exact: true}).last().click();
    await page.getByRole('button', {name: 'Suggest change', exact: true}).click();
    const composer = page.getByRole('textbox', {name: 'Review comment', exact: true});
    await expect(composer).toHaveValue('```suggestion\nreview me\n```');
    await composer.fill('```suggestion\napplied\n```');
    await page.getByRole('button', {name: 'Add single comment', exact: true}).click();
    await page.getByRole('button', {name: 'Commit suggestion', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'Commit suggestions'});
    await dialog.getByRole('textbox', {name: 'Commit message'}).fill('Apply review suggestion');
    await dialog.getByRole('button', {name: 'Commit', exact: true}).click();
    await expect(dialog).not.toBeVisible();
    const changed = await (await ok(await api('GET', `${path}/contents/example.txt?ref=suggestion`), 'read committed file')).json() as {content: string};
    expect(Buffer.from(changed.content, 'base64').toString()).toBe('applied\n');
  } finally {
    await api('DELETE', path);
  }
});
