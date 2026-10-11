// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, b64, ok} from '../lib/api.ts';
import {signIn} from '../lib/app.ts';
import {changeFiles, codeUrl} from '../lib/code.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

// No runner registers this label: cancellation and rerun can be tested without one.
test('cancel a queued run, rerun all jobs and one job, with synced status echoes', async ({page}) => {
  const repo = `actions-${Date.now().toString(36)}`;
  await ok(await api('POST', '/user/repos', {name: repo, auto_init: true, default_branch: 'main'}), 'create repo');
  try {
    await ok(await api('PATCH', `/repos/${USER}/${repo}`, {has_actions: true}), 'enable actions');
    await changeFiles(repo, {branch: 'main', message: 'Seed CI', files: [{operation: 'create', path: '.forgejo/workflows/ci.yml', content: b64('on: [push]\njobs:\n  build:\n    runs-on: next-e2e-no-runner\n    steps:\n      - run: echo hello\n')}]});
    const path = `/repos/${USER}/${repo}/actions/runs`;
    let run: {id: number; index_in_repo: number; status: string} | undefined;
    await expect.poll(async () => {
      const result = await (await ok(await api('GET', path), 'list runs')).json() as {workflow_runs: {id: number; index_in_repo: number; status: string}[]};
      run = result.workflow_runs[0];
      return !!run;
    }).toBe(true);
    if (!run) throw new Error('No seeded run');
    const seeded = run;
    const status = async () => (await (await ok(await api('GET', `${path}/${String(seeded.id)}`), 'run')).json() as {status: string}).status;
    await signIn(page);
    await page.goto(codeUrl(repo, `actions/runs/${String(seeded.index_in_repo)}`));
    const cancel = page.getByRole('button', {name: 'Cancel workflow', exact: true});
    await expect(cancel).toBeEnabled({timeout: 20_000});
    await cancel.click();
    await expect.poll(status).toBe('cancelled');
    const rerun = page.getByRole('button', {name: 'Re-run', exact: true});
    await expect(rerun).toBeEnabled();
    await page.getByRole('button', {name: 'Re-run options'}).click();
    await expect(page.getByRole('menuitem', {name: 'Re-run failed jobs'})).toBeDisabled();
    await page.getByRole('menuitem', {name: 'Re-run all jobs'}).click();
    await expect.poll(status).toBe('waiting');
    await expect(cancel).toBeEnabled();
    await cancel.click();
    await expect.poll(status).toBe('cancelled');
    await expect(page.getByRole('button', {name: 'Re-run job', exact: true}).first()).toBeEnabled();
    await page.getByRole('button', {name: 'Re-run job', exact: true}).first().click();
    await expect.poll(status).toBe('waiting');
  } finally {
    await api('DELETE', `/repos/${USER}/${repo}`);
  }
});
