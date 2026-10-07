// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The boot shell of the production build: the splash state is applied before
// first paint, by the inline script alone, and the app then boots without a
// CSS request.

import {expect, test, type Page} from '@playwright/test';

const darkCanvas = 'rgb(15, 16, 18)'; // --color-canvas, dark (tokens.css)
const lightCanvas = 'rgb(247, 247, 248)';

async function seed(page: Page, splash: object) {
  await page.addInitScript((s) => {
    localStorage.setItem('splash', s);
  }, JSON.stringify(splash));
}

/** Records <html data-theme> and the page background at the first animation frame. */
async function recordFirstFrame(page: Page) {
  await page.addInitScript(() => {
    requestAnimationFrame(() => {
      const html = document.documentElement;
      (window as unknown as {firstFrame: object}).firstFrame = {
        theme: html.dataset.theme,
        background: getComputedStyle(html).backgroundColor,
        hasBody: Boolean(document.body),
      };
    });
  });
}

test('stored splash is applied by the inline script alone (app JS blocked)', async ({page}) => {
  await page.route('**/assets/*.js', (route) => route.abort());
  await seed(page, {theme: 'dark', user: '1', sidebarWidth: 300, skeleton: {shape: 'list', rows: 5}, initial: 'A'});
  await page.goto('/-/next/');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(html).toHaveAttribute('data-shell', 'app');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(darkCanvas);
  expect((await page.locator('aside').boundingBox())?.width).toBe(300);
  await expect(page.locator('[data-sk-row]:visible')).toHaveCount(5);
  await expect(page.getByText('Sign in to continue.')).toBeHidden();
  expect(await page.locator('.splash-initial').evaluate((el) => getComputedStyle(el, '::after').content)).toBe('"A"');
});

test('the first frame already has the stored theme', async ({page}) => {
  await recordFirstFrame(page);
  await seed(page, {theme: 'dark', user: '1'});
  await page.goto('/-/next/');
  await page.waitForFunction(() => 'firstFrame' in window);
  expect(await page.evaluate(() => (window as unknown as {firstFrame: object}).firstFrame)).toEqual({
    theme: 'dark', background: darkCanvas, hasBody: true,
  });
});

test('detail skeleton shape', async ({page}) => {
  await page.route('**/assets/*.js', (route) => route.abort());
  await seed(page, {user: '1', skeleton: {shape: 'detail'}});
  await page.goto('/-/next/');
  await expect(page.locator('[data-sk-row]:visible')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-skeleton', 'detail');
});

test('system theme follows the OS when nothing is stored', async ({page}) => {
  await page.emulateMedia({colorScheme: 'dark'});
  await page.route('**/assets/*.js', (route) => route.abort());
  await page.goto('/-/next/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('no local DB marker: logged-out shell, then the app boots from preloaded chunks without CSS requests', async ({page}) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/-/next/');
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'logged-out');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)).toBe(lightCanvas);
  await expect(page.getByRole('button', {name: 'Sign in'})).toBeVisible();
  expect(await page.evaluate(() => performance.getEntriesByName('appStart').length)).toBe(1);

  const preloads = await page.locator('link[rel=modulepreload]').evaluateAll((ls) => ls.map((l) => new URL((l as HTMLLinkElement).href).pathname));
  const scripts = requests.filter((p) => p.endsWith('.js'));
  // Every script the boot fetched was announced in the HTML (no late discovery).
  const entry = await page.locator('script[type=module]').getAttribute('src');
  for (const s of scripts) expect([...preloads, entry]).toContain(s);
  expect(preloads.some((p) => /\/Home-[\w-]+\.js$/.test(p))).toBe(true);
  expect(requests.filter((p) => p.endsWith('.css'))).toEqual([]);
  expect(errors).toEqual([]);
});
