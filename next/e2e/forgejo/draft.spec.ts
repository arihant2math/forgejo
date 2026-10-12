import {expect, test} from '@playwright/test';
import {api, seed} from '../lib/api.ts';
import {indicator, signedIn} from '../lib/app.ts';
import {goOffline, goOnline} from '../lib/device.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

test('draft becomes ready offline, can be undone, and syncs its title', async ({browser}) => {
  const repo = 'p80';
  seed(repo, 1);
  const head = `draft-${String(Date.now())}`;
  expect((await api('POST', `/repos/${USER}/${repo}/contents`, {branch: 'main', new_branch: head, message: 'Draft change', files: [{operation: 'create', path: `${head}.txt`, content: 'aGVsbG8='}]})).ok).toBe(true);
  const response = await api('POST', `/repos/${USER}/${repo}/pulls`, {head, base: 'main', title: `WIP: ${head}`});
  expect(response.ok).toBe(true);
  const pull = await response.json() as {number: number};
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(`${BASE}/${USER}/${repo}/pulls/${String(pull.number)}`);
  await expect(page.getByRole('button', {name: 'Ready for review', exact: true})).toBeVisible();
  await goOffline(ctx, page);
  await page.getByRole('button', {name: 'Ready for review', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Convert to draft'})).toBeVisible();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(page.getByRole('button', {name: 'Ready for review', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Ready for review', exact: true}).click();
  await goOnline(ctx, page);
  await expect(indicator(page)).not.toContainText('pending', {timeout: 20_000});
  await expect.poll(async () => (await (await api('GET', `/repos/${USER}/${repo}/pulls/${String(pull.number)}`)).json() as {title: string}).title).toBe(head);
  await page.getByRole('button', {name: 'Convert to draft'}).click();
  await expect(page.getByRole('button', {name: 'Ready for review', exact: true})).toBeVisible();
  await ctx.close();
});
