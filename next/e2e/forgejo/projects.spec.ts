// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from '@playwright/test';
import {expectPressed, signedIn, watch} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

test('create, edit, close, reopen and delete a personal board without Classic', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  const title = `Planning ${String(Date.now())}`;
  await page.goto(`${BASE}/${USER}`);
  await page.getByRole('navigation', {name: 'Profile sections'}).getByRole('link', {name: 'Boards'}).click();
  await expect(page).toHaveURL(/[?&]tab=boards/);
  await page.getByRole('button', {name: 'New board', exact: true}).click();
  const form = page.getByRole('dialog', {name: 'New board'});
  await form.getByRole('textbox', {name: 'Title', exact: true}).fill(title);
  await form.getByRole('textbox', {name: 'Description'}).fill('Monthly planning');
  await form.getByRole('button', {name: 'Basic kanban'}).click();
  await expectPressed(form.getByRole('button', {name: 'Basic kanban'}));
  await form.getByRole('button', {name: 'Create board'}).click();
  await expect(page.getByRole('heading', {level: 1, name: title})).toBeVisible({timeout: 30_000});
  const boardURL = page.url();
  await page.getByRole('button', {name: 'Board settings'}).click();
  await page.getByRole('menuitem', {name: 'Edit board'}).click();
  const edit = page.getByRole('dialog', {name: 'Edit board'});
  await edit.getByRole('textbox', {name: 'Title', exact: true}).fill(`${title} updated`);
  await edit.getByRole('textbox', {name: 'Description'}).fill('');
  await edit.getByRole('button', {name: 'Save changes'}).click();
  await expect(page.getByRole('heading', {level: 1, name: `${title} updated`})).toBeVisible();
  await page.getByRole('button', {name: 'Board settings'}).click();
  await page.getByRole('menuitem', {name: 'Close board', exact: true}).click();
  await expect(page.getByText('Closed', {exact: true}).first()).toBeVisible();
  await page.goto(`${BASE}/-/next/boards`);
  await page.getByRole('button', {name: 'Closed', exact: true}).click();
  await page.getByRole('link', {name: `${title} updated`, exact: true}).click();
  await page.getByRole('button', {name: 'Board settings'}).click();
  await page.getByRole('menuitem', {name: 'Reopen board'}).click();
  await page.getByRole('button', {name: 'Board settings'}).click();
  await expect(page.getByRole('menuitem', {name: 'Close board', exact: true})).toBeVisible();
  await page.keyboard.press('Escape');
  await ctx.setOffline(true);
  await expect(page.getByRole('button', {name: 'Board settings'})).toBeDisabled();
  await ctx.setOffline(false);
  await page.goto(boardURL);
  await page.getByRole('button', {name: 'Board settings'}).click();
  await page.getByRole('menuitem', {name: 'Delete board…'}).click();
  const remove = page.getByRole('dialog', {name: 'Delete board?'});
  await remove.getByRole('textbox').fill(`${title} updated`);
  await remove.getByRole('button', {name: 'Delete board', exact: true}).click();
  await expect(page).toHaveURL(`${BASE}/-/next/boards`);
  await expect(page.getByRole('link', {name: `${title} updated`, exact: true})).toHaveCount(0);
  expect(problems).toEqual([]);
  await ctx.close();
});
