// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {newIssue, seed} from '../lib/api.ts';
import {signedIn} from '../lib/app.ts';
import {goOffline, goOnline} from '../lib/device.ts';
import {BASE, USER} from '../lib/env.ts';
import {classicColumn, classicProject} from '../lib/projects.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

test('board adds two existing issues offline and removes one, then syncs', async ({browser}) => {
  const repo = 'board-items';
  seed(repo, 1);
  const stamp = `Board items ${Date.now()}`;
  const anchor = await newIssue(USER, repo, `${stamp} anchor`);
  const first = await newIssue(USER, repo, `${stamp} first`);
  const second = await newIssue(USER, repo, `${stamp} second`);
  const context = await browser.newContext();
  const page = await signedIn(context);
  const id = await classicProject(page, USER, repo, stamp, [anchor]);
  await page.goto(`${BASE}/-/next/projects/${id}`);
  await expect(page.locator(`[data-card="${anchor.id}"]`)).toBeVisible();
  const column = page.locator('section[data-column]').first();
  await goOffline(context, page);
  await column.getByRole('button', {name: 'Add existing issue…'}).click();
  const dialog = page.getByRole('dialog', {name: 'Add existing issues'});
  await dialog.getByPlaceholder('Search by number or title…').fill(stamp);
  await dialog.getByRole('option', {name: new RegExp(first.title)}).click();
  await dialog.getByRole('option', {name: new RegExp(second.title)}).click();
  await dialog.getByRole('option', {name: 'Add 2 selected issues'}).click();
  const card = page.locator(`[data-card="${first.id}"]`);
  await expect(card).toBeVisible();
  await expect(page.locator(`[data-card="${second.id}"]`)).toBeVisible();
  await card.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Remove from board', exact: true}).click();
  await expect(card).toHaveCount(0);
  await goOnline(context, page);
  await expect.poll(() => classicColumn(page, USER, repo, id, second)).toBeTruthy();
  await expect.poll(() => classicColumn(page, USER, repo, id, first)).toBeUndefined();
  await context.close();
});
