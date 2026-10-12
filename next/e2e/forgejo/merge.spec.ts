import {expect, test} from '@playwright/test';
import {api, apiJson, b64, ok} from '../lib/api.ts';
import {signedIn} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

const REPO = `merge-${Date.now().toString(36)}`;
const path = `/repos/${USER}/${REPO}`;

test.afterAll(async () => {
  await api('DELETE', path);
});

test('squash-only default, live settings, and confirmed rebase update', async ({browser}) => {
  await ok(await api('POST', '/user/repos', {name: REPO, auto_init: true, default_branch: 'main'}), 'create repository');
  await ok(await api('POST', `${path}/branches`, {new_branch_name: 'topic', old_branch_name: 'main'}), 'create branch');
  await ok(await api('POST', `${path}/contents/topic.txt`, {branch: 'topic', content: b64('topic\n'), message: 'Topic change'}), 'topic commit');
  await ok(await api('PATCH', path, {allow_merge_commits: false, allow_rebase: false, allow_rebase_explicit: false, allow_squash_merge: true, allow_fast_forward_only_merge: false, default_merge_style: 'squash', allow_rebase_update: false}), 'squash only');
  const pull = await apiJson<{number: number}>('POST', `${path}/pulls`, {base: 'main', head: 'topic', title: 'Merge methods'});
  await ok(await api('POST', `${path}/contents/base.txt`, {branch: 'main', content: b64('base\n'), message: 'Base change'}), 'advance base');
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(`${BASE}/${USER}/${REPO}/pulls/${String(pull.number)}`);
  const box = page.getByRole('region', {name: 'Merge'});
  await expect(box.getByRole('button', {name: 'Squash and merge', exact: true})).toBeEnabled({timeout: 30_000});
  await box.getByRole('button', {name: 'Select merge method'}).click();
  await expect(page.getByRole('menuitemradio')).toHaveCount(1);
  await expect(page.getByRole('menuitemradio', {name: /Squash and merge/})).toBeVisible();
  await page.keyboard.press('Escape');
  await box.getByRole('button', {name: 'Choose branch update method'}).click();
  await expect(page.getByRole('menuitem', {name: 'Update with rebase'})).toHaveCount(0);
  await page.keyboard.press('Escape');
  const settings = await ctx.newPage();
  await settings.goto(`${BASE}/${USER}/${REPO}/settings`);
  await settings.getByRole('switch', {name: 'Update branches by rebasing'}).click();
  await expect.poll(async () => (await apiJson<{allow_rebase_update: boolean}>('GET', path)).allow_rebase_update).toBe(true);
  await box.getByRole('button', {name: 'Choose branch update method'}).click();
  await expect(page.getByRole('menuitem', {name: 'Update with rebase'})).toBeVisible({timeout: 30_000});
  await page.getByRole('menuitem', {name: 'Update with rebase'}).click();
  await expect(page.getByRole('dialog')).toContainText('force-pushes the head branch');
  await page.getByRole('button', {name: 'Rebase and force-push'}).click();
  await expect(box.getByRole('button', {name: 'Update branch', exact: true})).toHaveCount(0, {timeout: 30_000});
  await box.getByRole('button', {name: 'Squash and merge', exact: true}).click();
  await box.getByRole('button', {name: 'Confirm squash and merge', exact: true}).click();
  await expect.poll(async () => (await apiJson<{merged: boolean}>('GET', `${path}/pulls/${String(pull.number)}`)).merged, {timeout: 30_000}).toBe(true);
  await ctx.close();
});
