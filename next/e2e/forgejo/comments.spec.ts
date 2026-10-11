// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {api, newIssue, seed} from '../lib/api.ts';
import {indicator, signedIn} from '../lib/app.ts';
import {goOffline, goOnline} from '../lib/device.ts';
import {aliceAuth, BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
const REPO = 'comment-actions';
test.beforeAll(() => { seed(REPO, 1); });

test('close and reopen with comments offline, quote, and moderate another author', async ({browser}) => {
  const target = await newIssue(USER, REPO, `Comment actions ${String(Date.now())}`, 'Discussion');
  const path = `/repos/${USER}/${REPO}/issues/${String(target.number)}`;
  const posted = await (await api('POST', `${path}/comments`, {body: 'Quote this paragraph.'}, aliceAuth)).json() as {id: number};
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(`${BASE}/${USER}/${REPO}/issues/${String(target.number)}`);
  const card = page.locator(`#comment-${String(posted.id)}`);
  await expect(card).toContainText('Quote this paragraph.', {timeout: 20_000});
  await card.getByRole('button', {name: 'Comment actions'}).click();
  await page.getByRole('menuitem', {name: 'Quote reply'}).click();
  const composer = page.getByRole('textbox', {name: 'Leave a comment'});
  await expect(composer).toContainText('> Quote this paragraph.');
  await expect(composer).toBeFocused();
  await goOffline(ctx, page);
  await composer.fill('Closing offline');
  await page.getByRole('button', {name: 'Close with comment', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Reopen issue', exact: true})).toBeVisible();
  await composer.fill('Reopening offline');
  await composer.press('ControlOrMeta+Shift+Enter');
  await expect(page.getByRole('button', {name: 'Close issue', exact: true})).toBeVisible();
  await card.getByRole('button', {name: 'Comment actions'}).click();
  await page.getByRole('menuitem', {name: 'Edit', exact: true}).click();
  await card.getByRole('textbox', {name: 'Comment', exact: true}).fill('Moderated by maintainer');
  await card.getByRole('button', {name: 'Save', exact: true}).click();
  await goOnline(ctx, page);
  await expect(indicator(page)).not.toContainText('pending', {timeout: 20_000});
  await expect.poll(async () => {
    const list = await (await api('GET', `${path}/comments`)).json() as {body: string}[];
    return list.map((c) => c.body);
  }).toEqual(expect.arrayContaining(['Closing offline', 'Reopening offline', 'Moderated by maintainer']));
  await expect(card).toContainText(`by ${USER}`);
  await card.getByRole('button', {name: 'Comment actions'}).click();
  await page.getByRole('menuitem', {name: 'Delete…'}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Delete', exact: true}).click();
  await expect.poll(async () => (await api('GET', `/repos/${USER}/${REPO}/issues/comments/${String(posted.id)}`)).status).toBe(404);
  const after = await (await api('GET', path)).json() as {state: string};
  expect(after.state).toBe('open');
  await ctx.close();
});
