// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Browser layout is required to verify independent property and conversation scrolling.

import {expect, type Locator, test} from '@playwright/test';
import {api, ok} from '../lib/api.ts';
import {signIn} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

const repo = `issue-layout-${Date.now().toString(36)}`;

test.afterAll(async () => {
  await api('DELETE', `/repos/${USER}/${repo}`);
});

const scrolls = (pane: Locator) => pane.evaluate((aside) => {
  const own = aside.firstElementChild as HTMLElement;
  const body = aside.closest<HTMLElement>('[data-scroll-restoration-id="page"]');
  if (!body) throw new Error('no page body');
  return {pane: own.scrollTop, page: body.scrollTop, overflows: own.scrollHeight > own.clientHeight + 1,
    atEnd: own.scrollTop + own.clientHeight >= own.scrollHeight - 1,
    fits: own.getBoundingClientRect().height <= body.clientHeight + 1, top: own.getBoundingClientRect().top - body.getBoundingClientRect().top};
});

test('on a wide page the properties scroll on their own, and the conversation leaves them alone', async ({page}) => {
  await ok(await api('POST', '/user/repos', {name: repo, auto_init: true, default_branch: 'main'}), 'create repo');
  const issue = await (await ok(await api('POST', `/repos/${USER}/${repo}/issues`, {title: 'A long conversation', body: 'The description.'}), 'create issue')).json() as {number: number};
  for (let i = 1; i <= 12; i++) await ok(await api('POST', `/repos/${USER}/${repo}/issues/${String(issue.number)}/comments`, {body: `Comment ${String(i)}\n\n${'A line of text. '.repeat(40)}`}), 'comment');
  // Use a short, wide viewport so the side-by-side properties overflow.
  await page.setViewportSize({width: 1440, height: 560});
  await signIn(page);
  await page.goto(`${BASE}/${USER}/${repo}/issues/${String(issue.number)}`);
  const pane = page.getByRole('complementary', {name: 'Properties'});
  await expect(pane.getByText('Assignees', {exact: true})).toBeVisible();
  await expect(page.getByText('Comment 1', {exact: true})).toBeVisible();

  const start = await scrolls(pane);
  expect(start).toMatchObject({pane: 0, page: 0, overflows: true, fits: true});

  const last = pane.getByRole('button').last();
  await pane.getByRole('button').first().focus();
  for (let i = 0; i < 60 && !await last.evaluate((el) => el === document.activeElement); i++) await page.keyboard.press('Tab');
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport();
  expect(await scrolls(pane)).toMatchObject({page: 0});
  expect((await scrolls(pane)).pane).toBeGreaterThan(0);
  await last.blur();
  await pane.evaluate((aside) => {
    aside.firstElementChild?.scrollTo(0, 0);
  });

  const box = await pane.boundingBox();
  if (!box) throw new Error('no properties box');
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.wheel(0, 3000);
  await expect.poll(async () => (await scrolls(pane)).pane).toBeGreaterThan(0);
  await expect.poll(async () => (await scrolls(pane)).atEnd).toBe(true);
  const paned = await scrolls(pane);
  expect(paned.page).toBe(0);
  await expect(pane.getByRole('button').last()).toBeInViewport();

  await page.mouse.move(box.x - 300, box.y + 200);
  await page.mouse.wheel(0, 1500);
  await expect.poll(async () => (await scrolls(pane)).page).toBeGreaterThan(0);
  const after = await scrolls(pane);
  expect(after.pane).toBe(paned.pane);
  expect(Math.abs(after.top)).toBeLessThanOrEqual(1);

  await page.setViewportSize({width: 600, height: 800});
  await expect.poll(() => pane.evaluate((aside) => getComputedStyle(aside.firstElementChild as HTMLElement).overflowY)).toBe('visible');
  expect(await pane.evaluate((aside) => getComputedStyle(aside.firstElementChild as HTMLElement).position)).toBe('static');
});
