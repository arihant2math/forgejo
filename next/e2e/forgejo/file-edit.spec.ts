// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {expect, test} from '@playwright/test';
import {api, b64, ok} from '../lib/api.ts';
import {signIn} from '../lib/app.ts';
import {codeUrl} from '../lib/code.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

test('edit markdown, commit to a new branch, and open a pull request', async ({page}) => {
  const repo = `file-edit-${Date.now().toString(36)}`;
  await ok(await api('POST', '/user/repos', {name: repo, auto_init: true, default_branch: 'main'}), 'create repository');
  try {
    await ok(await api('POST', `/repos/${USER}/${repo}/contents/docs.md`, {branch: 'main', content: b64('# Original\n'), message: 'Add docs'}), 'add markdown');
    await signIn(page);
    await page.goto(codeUrl(repo, 'src/branch/main/docs.md'));
    await page.getByRole('button', {name: 'Edit this file', exact: true}).click();
    const editor = page.getByRole('textbox', {name: 'File contents'});
    await editor.fill('# Updated documentation\n');
    await page.getByRole('radio', {name: 'Preview', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Updated documentation'})).toBeVisible();
    await page.getByRole('button', {name: 'Commit changes…', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'Commit changes'});
    await dialog.getByLabel('Create a new branch').check();
    await dialog.getByRole('textbox', {name: 'New branch name'}).fill('docs-update');
    await dialog.getByRole('button', {name: 'Commit changes', exact: true}).click();
    await page.getByRole('button', {name: 'Create pull request', exact: true}).click();
    await expect(page).toHaveURL(/\/pulls\/\d+/);
    const content = await (await ok(await api('GET', `/repos/${USER}/${repo}/contents/docs.md?ref=docs-update`), 'read edited file')).json() as {content: string};
    expect(Buffer.from(content.content, 'base64').toString()).toBe('# Updated documentation\n');
    const pulls = await (await ok(await api('GET', `/repos/${USER}/${repo}/pulls?state=open`), 'read pulls')).json() as {head: {ref: string}; base: {ref: string}}[];
    expect(pulls.some((pull) => pull.head.ref === 'docs-update' && pull.base.ref === 'main')).toBe(true);
  } finally {
    await api('DELETE', `/repos/${USER}/${repo}`);
  }
});
