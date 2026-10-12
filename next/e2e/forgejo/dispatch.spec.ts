// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, b64, ensureUser, ok} from '../lib/api.ts';
import {signIn} from '../lib/app.ts';
import {changeFiles, codeUrl} from '../lib/code.ts';
import {ALICE, BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});
const REPO = `dispatch-${Date.now().toString(36)}`;
const workflow = `name: Manual deployment
on:
  workflow_dispatch:
    inputs:
      target:
        description: Deployment target
        type: choice
        required: true
        default: staging
        options: [staging, production]
      dry_run:
        type: boolean
        default: true
      count:
        type: number
        default: 2
      message:
        required: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo dispatched
`;

test.beforeAll(async () => {
  await ensureUser(ALICE.user);
  await ok(await api('POST', '/user/repos', {name: REPO, auto_init: true, default_branch: 'main'}), 'create dispatch repo');
  await ok(await api('PATCH', `/repos/${USER}/${REPO}`, {has_actions: true}), 'enable actions');
  await changeFiles(REPO, {branch: 'main', message: 'Add manual workflow', files: [
    {operation: 'create', path: '.forgejo/workflows/deploy.yml', content: b64(workflow)},
    {operation: 'create', path: '.forgejo/workflows/ci.yml', content: b64('on: push\njobs: {}\n')},
  ]});
  await ok(await api('POST', `/repos/${USER}/${REPO}/tags`, {tag_name: 'v1', target: 'main'}), 'create dispatch tag');
});

test.afterAll(async () => { await api('DELETE', `/repos/${USER}/${REPO}`); });

test('manually dispatch a never-run workflow with typed inputs on a tag, then open its run', async ({page, context}) => {
  await signIn(page);
  await page.goto(`${codeUrl(REPO, 'actions')}?workflow=ci.yml`);
  await expect(page.getByRole('button', {name: 'ci.yml', exact: true})).toBeVisible({timeout: 20_000});
  await expect(page.getByRole('button', {name: 'Run workflow', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: 'ci.yml', exact: true}).click();
  await page.getByRole('option', {name: 'deploy.yml', exact: true}).click();
  const run = page.getByRole('button', {name: 'Run workflow', exact: true});
  await expect(run).toBeVisible();
  await context.setOffline(true);
  await expect(run).toBeDisabled();
  await context.setOffline(false);
  await expect(run).toBeEnabled();
  await run.click();
  const dialog = page.getByRole('dialog', {name: 'Run workflow'});
  await expect(dialog.getByLabel('count', {exact: true})).toHaveValue('2');
  await expect(dialog.getByRole('button', {name: 'dry_run', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', {name: 'Run on: main'}).click();
  await page.getByRole('option', {name: 'v1', exact: true}).click();
  await expect(dialog.getByLabel('count', {exact: true})).toHaveValue('2');
  await dialog.getByLabel('target', {exact: true}).selectOption('production');
  await dialog.getByRole('button', {name: 'dry_run', exact: true}).click();
  await dialog.getByLabel('count', {exact: true}).fill('3');
  await dialog.getByRole('button', {name: 'Run workflow', exact: true}).click();
  await expect(dialog.getByRole('alert')).toHaveText('message is required.');
  await dialog.getByLabel('message', {exact: true}).fill('release');
  const dispatched = page.waitForResponse((response) => response.url().includes('/actions/workflows/deploy.yml/dispatches') && response.request().method() === 'POST');
  await dialog.getByRole('button', {name: 'Run workflow', exact: true}).click();
  const response = await dispatched;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({ref: 'refs/tags/v1', inputs: {target: 'production', dry_run: 'false', count: '3', message: 'release'}, return_run_info: true});
  const result = await response.json() as {id: number; run_number: number};
  await expect(page).toHaveURL(new RegExp(`actions/runs/${String(result.run_number)}`));
  await expect.poll(async () => {
    const runs = await (await ok(await api('GET', `/repos/${USER}/${REPO}/actions/runs?workflow_id=deploy.yml`), 'runs')).json() as {workflow_runs: {id: number; event: string; prettyref: string}[]};
    return runs.workflow_runs.some((entry) => entry.id === result.id && entry.event === 'workflow_dispatch' && entry.prettyref === 'v1');
  }).toBe(true);
});

test('readers can filter workflows but cannot dispatch them', async ({page}) => {
  await signIn(page, ALICE.user, ALICE.password);
  await page.goto(`${codeUrl(REPO, 'actions')}?workflow=deploy.yml`);
  await expect(page.getByRole('button', {name: 'deploy.yml', exact: true})).toBeVisible({timeout: 20_000});
  await expect(page.getByRole('button', {name: 'Run workflow', exact: true})).toHaveCount(0);
});
