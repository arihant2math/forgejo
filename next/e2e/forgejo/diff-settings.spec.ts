// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, b64, ok} from '../lib/api.ts';
import {fillMarkdown, signIn} from '../lib/app.ts';
import {blobSha, changeFiles, codeUrl, commentOnLine, type Pull} from '../lib/code.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
const REPO = `diff-settings-${Date.now().toString(36)}`;
let pull: Pull;

test.beforeAll(async () => {
  await ok(await api('POST', '/user/repos', {name: REPO, auto_init: true, default_branch: 'main'}), 'create repo');
  await changeFiles(REPO, {branch: 'main', message: 'Source', files: [{operation: 'create', path: 'space.txt', content: b64('one two\nthree four\n')}]});
  await changeFiles(REPO, {branch: 'main', new_branch: 'spaces', message: 'Whitespace only', files: [{operation: 'update', path: 'space.txt', sha: await blobSha(REPO, 'space.txt'), content: b64('one  two\nthree four  \n')}]});
  pull = await (await ok(await api('POST', `/repos/${USER}/${REPO}/pulls`, {head: 'spaces', base: 'main', title: 'Whitespace only'}), 'create pull')).json() as Pull;
});

test.afterAll(async () => { await api('DELETE', `/repos/${USER}/${REPO}`); });

test('diff settings: split, remembered whitespace variant, and shared w=1 link', async ({page}) => {
  await signIn(page);
  await page.goto(`${BASE}/${USER}/${REPO}/pulls/${String(pull.number)}?tab=files`);
  await expect(page.getByRole('region', {name: 'Changes'})).toBeVisible();
  await page.getByRole('button', {name: 'Diff settings'}).click();
  await page.getByRole('button', {name: 'Split', exact: true}).click();
  await page.keyboard.press('Escape');
  const changes = page.getByRole('region', {name: 'Changes'});
  await changes.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await fillMarkdown(page, 'Review comment', 'New-side draft');
  await page.getByRole('button', {name: 'Start a review', exact: true}).click();
  await expect(page.getByText('New-side draft', {exact: true})).toBeVisible();
  await commentOnLine(page, 'one two', 'Comment on old line 1', 'change-deletion');
  await fillMarkdown(page, 'Review comment', 'Old-side draft');
  await page.getByRole('button', {name: 'Add review comment', exact: true}).click();
  await expect(page.getByText('Old-side draft', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Diff settings'}).click();
  await page.getByRole('button', {name: 'Hide whitespace changes'}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('No changes', {exact: true})).toBeVisible();
  await page.goto(codeUrl(REPO, `commit/${pull.head.sha}`));
  await expect(page.getByText('No changes', {exact: true})).toBeVisible();
  await page.goto(codeUrl(REPO, 'compare/main...spaces'));
  await expect(page.getByText('No changes', {exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Diff settings'}).click();
  await expect(page.getByRole('button', {name: 'Split', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', {name: 'Hide whitespace changes'}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', {name: 'Changes'})).toBeVisible();
  await page.goto(`${page.url()}?w=1`);
  await expect(page.getByText('No changes', {exact: true})).toBeVisible();
});
