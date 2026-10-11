// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The wiki against a real Forgejo: an empty wiki's "Create the first page",
// a link to a page that does not exist yet, editing, the page list (and the
// classic ?action=_pages address), deleting with a confirmation, and a page
// seen once shown offline from the device.

import {expect, test} from '@playwright/test';
import {api, ok} from '../lib/api.ts';
import {signedIn, watch} from '../lib/app.ts';
import {goOffline, swReady} from '../lib/device.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

const REPO = `wiki-${String(Date.now())}`;

test.beforeAll(async () => {
  await ok(await api('POST', '/user/repos', {name: REPO, auto_init: true, default_branch: 'main'}), 'create repo');
});

test('a wiki from its first page to a deleted one, and offline once seen', async ({browser}) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  const wiki = `${BASE}/${USER}/${REPO}/wiki`;
  const main = page.getByRole('main');

  // An empty wiki: its first page, with the title Home.
  await page.goto(wiki);
  await expect(main.getByText('This wiki has no pages yet')).toBeVisible({timeout: 20_000});
  await main.getByRole('link', {name: 'Create the first page'}).click();
  await expect(page).toHaveURL(`${wiki}/-/new?title=Home`);
  await expect(page.getByRole('textbox', {name: 'Title'})).toHaveValue('Home');
  await page.getByRole('textbox', {name: 'Content'}).fill('Welcome to the wiki. See [[Second Page]].');
  await page.getByRole('button', {name: 'Create page'}).click();
  await expect(page).toHaveURL(`${wiki}/Home`);
  const article = main.getByRole('article');
  await expect(article).toContainText('Welcome to the wiki.');
  await expect(article).toContainText('edited this page');
  expect((await api('GET', `/repos/${USER}/${REPO}/wiki/page/Home`)).status).toBe(200);

  // A link to a page that does not exist yet: creating it from there.
  await article.getByRole('link', {name: 'Second Page'}).click();
  await expect(page).toHaveURL(`${wiki}/Second-Page`);
  await expect(main.getByText('No such page')).toBeVisible();
  await main.getByRole('link', {name: 'Create “Second Page”'}).click();
  await page.getByRole('textbox', {name: 'Content'}).fill('The second page.');
  await page.getByRole('button', {name: 'Create page'}).click();
  await expect(page).toHaveURL(`${wiki}/Second-Page`);
  await expect(article).toContainText('The second page.');
  const pages = page.getByRole('navigation', {name: 'Pages'});
  await expect(pages.getByRole('link')).toHaveText(['Home', 'Second Page']);

  // Editing.
  await page.getByRole('link', {name: 'Edit', exact: true}).click();
  await expect(page).toHaveURL(`${wiki}/Second-Page/-/edit`);
  await page.getByRole('textbox', {name: 'Content'}).fill('The second page, edited.');
  await page.getByRole('button', {name: 'Save'}).click();
  await expect(page).toHaveURL(`${wiki}/Second-Page`);
  await expect(article).toContainText('The second page, edited.');

  // The page list, also at the classic address.
  await page.goto(`${wiki}/?action=_pages`);
  await expect(page).toHaveURL(`${wiki}/-/pages`);
  await expect(page.getByRole('listbox', {name: 'Pages'}).getByRole('option')).toHaveCount(2);

  // Deleting, confirmed.
  await page.goto(`${wiki}/Second-Page`);
  await expect(article).toContainText('The second page, edited.');
  await page.getByRole('button', {name: 'More of this page'}).click();
  await page.getByRole('menuitem', {name: 'Delete page'}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Delete'}).click();
  await expect(page).toHaveURL(wiki);
  await expect.poll(async () => (await api('GET', `/repos/${USER}/${REPO}/wiki/page/Second-Page`)).status).toBe(404);
  await expect(pages.getByRole('link')).toHaveText(['Home']);

  // Seen once: there offline too.
  await swReady(page);
  await goOffline(ctx, page);
  await page.goto(`${wiki}/Home`);
  await expect(main.getByRole('article')).toContainText('Welcome to the wiki.', {timeout: 20_000});
  expect(problems).toEqual([]);
  await ctx.close();
});
