// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, apiJson, newIssue, seed} from '../lib/api.ts';
import {signedIn, watch} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
const REPO = `attachments-${Date.now().toString(36)}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=', 'base64');

test.beforeAll(() => { seed(REPO, 1); });
test.afterAll(async () => { await api('DELETE', `/repos/${USER}/${REPO}`); });

test('attach a screenshot to a new comment, post it, and verify its asset in Forgejo', async ({browser}) => {
  const issue = await newIssue(USER, REPO, 'Screenshot attachments');
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  await page.goto(`${BASE}/${USER}/${REPO}/issues/${String(issue.number)}`);
  const editor = page.getByRole('textbox', {name: 'Leave a comment'});
  await editor.fill('A screenshot: ');
  await expect(page.getByRole('button', {name: 'Attach files', exact: true})).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', {name: 'Attach files', exact: true}).click();
  await (await chooser).setFiles({name: 'screenshot.png', mimeType: 'image/png', buffer: png});
  await expect(editor).toContainText('![screenshot.png](', {timeout: 30_000});
  await expect(page.getByRole('status').filter({hasText: 'Uploading'})).toHaveCount(0);
  await page.getByRole('button', {name: 'Comment', exact: true}).click();
  const image = page.getByRole('region', {name: 'Activity'}).getByRole('img', {name: 'screenshot.png'});
  await expect(image).toBeVisible({timeout: 30_000});
  const comments = await apiJson<{id: number; body: string}[]>('GET', `/repos/${USER}/${REPO}/issues/${String(issue.number)}/comments`);
  const comment = comments.find((c) => c.body.includes('![screenshot.png]('));
  if (!comment) throw new Error('The comment was not posted');
  const assets = await apiJson<{name: string; browser_download_url: string}[]>('GET', `/repos/${USER}/${REPO}/issues/comments/${String(comment.id)}/assets`);
  expect(assets).toHaveLength(1);
  const asset = assets[0];
  if (!asset) throw new Error('The comment has no attachment');
  expect(asset.name).toBe('screenshot.png');
  expect(comment.body).toContain(asset.browser_download_url);
  const download = await page.request.get(asset.browser_download_url);
  expect(download.ok()).toBe(true);
  expect(await download.body()).toEqual(png);
  expect(problems).toEqual([]);
  await ctx.close();
});
