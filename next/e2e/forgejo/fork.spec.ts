// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, apiJson, ok} from '../lib/api.ts';
import {signedIn, watch} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
const RUN = Date.now().toString(36);
const SOURCE = `fork-source-${RUN}`;
const FORK = `fork-copy-${RUN}`;

test.afterAll(async () => {
  await api('DELETE', `/repos/${USER}/${FORK}`);
  await api('DELETE', `/repos/${USER}/${SOURCE}`);
});

test('fork from the header, choose a name and default branch only, then open the existing fork', async ({browser}) => {
  await ok(await api('POST', '/user/repos', {name: SOURCE, auto_init: true, description: 'Original'}), 'seed source');
  const source = await apiJson<{default_branch: string}>('GET', `/repos/${USER}/${SOURCE}`);
  await ok(await api('POST', `/repos/${USER}/${SOURCE}/branches`, {new_branch_name: 'extra', old_branch_name: source.default_branch}), 'seed another branch');
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  await page.goto(`${BASE}/${USER}/${SOURCE}`);
  await page.getByRole('button', {name: /^Fork ·/}).click();
  const dialog = page.getByRole('dialog', {name: 'Create a new fork'});
  await dialog.getByRole('textbox', {name: 'Repository name'}).fill(FORK);
  await expect(dialog.getByText(`${FORK} is available.`)).toBeVisible();
  await dialog.getByRole('textbox', {name: 'Description'}).fill('Forked in Next');
  await expect(dialog.getByRole('checkbox', {name: 'Copy the default branch only'})).toBeChecked();
  await dialog.getByRole('button', {name: 'Create fork', exact: true}).click();
  await expect(page).toHaveURL(`${BASE}/${USER}/${FORK}`, {timeout: 30_000});
  const fork = await apiJson<{fork: boolean; description: string; parent: {name: string}}>('GET', `/repos/${USER}/${FORK}`);
  expect(fork.fork).toBe(true);
  expect(fork.parent.name).toBe(SOURCE);
  expect(fork.description).toBe('Forked in Next');
  const branches = await apiJson<{name: string}[]>('GET', `/repos/${USER}/${FORK}/branches`);
  expect(branches.map((b) => b.name)).toEqual([source.default_branch]);
  await page.goto(`${BASE}/${USER}/${SOURCE}`);
  await page.getByRole('button', {name: /^Fork ·/}).click();
  await dialog.getByRole('button', {name: 'Open existing fork'}).click();
  await expect(page).toHaveURL(`${BASE}/${USER}/${FORK}`, {timeout: 30_000});
  expect(problems).toEqual([]);
  await ctx.close();
});
