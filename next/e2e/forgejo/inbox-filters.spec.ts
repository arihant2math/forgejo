// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {signIn} from '../lib/app.ts';
import {BASE} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

test('inbox review filter is linked, combinable and restored by Back', async ({page}) => {
  await signIn(page);
  await page.goto(`${BASE}/notifications`);
  await page.getByRole('button', {name: 'Reason', exact: true}).click();
  await page.getByRole('option', {name: 'Review requested', exact: true}).click();
  await expect(page).toHaveURL(/reason=review-requested/);
  await expect(page.getByRole('button', {name: 'Reason: Review requested', exact: true})).toBeVisible();
  await page.getByRole('button', {name: /^Unread/}).click();
  await expect(page).toHaveURL(/filter=unread/);
  await page.goBack();
  await expect(page).toHaveURL(/reason=review-requested/);
  await expect(page).not.toHaveURL(/filter=unread/);
  await page.getByRole('button', {name: 'Save view…', exact: true}).click();
  await page.getByRole('textbox', {name: 'View name'}).fill('Review inbox');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(page.getByRole('link', {name: 'Review inbox', exact: true})).toBeVisible();
});
