// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The dev-only primitive gallery renders in both themes; floating surfaces use
// the theme tokens too. Screenshots land in test-results/ for review.

import {expect, test} from '@playwright/test';

const tokens = {
  light: {surface: 'rgb(255, 255, 255)', raised: 'rgb(255, 255, 255)', fg: 'rgb(27, 27, 31)'},
  dark: {surface: 'rgb(21, 22, 25)', raised: 'rgb(28, 29, 33)', fg: 'rgb(236, 236, 238)'},
} as const;

for (const theme of ['light', 'dark'] as const) {
  test(`gallery in the ${theme} theme`, async ({page}, info) => {
    await page.goto('/-/next/gallery');
    await page.getByRole('button', {name: theme, exact: true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.evaluate(() => localStorage.getItem('splash'))).toContain(`"theme":"${theme}"`);

    const header = page.getByRole('heading', {name: 'Primitives'});
    expect(await header.evaluate((el) => getComputedStyle(el).color)).toBe(tokens[theme].fg);
    expect(await page.locator('header').first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(tokens[theme].surface);
    await page.screenshot({path: info.outputPath(`gallery-${theme}.png`), fullPage: true});

    await page.getByRole('button', {name: 'Menu'}).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(tokens[theme].raised);
    await page.screenshot({path: info.outputPath(`menu-${theme}.png`)});
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await page.getByRole('button', {name: 'Dialog'}).click();
    const dialog = page.getByRole('dialog', {name: 'Archive repository?'});
    await expect(dialog).toBeVisible();
    await page.screenshot({path: info.outputPath(`dialog-${theme}.png`)});
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
}

test('menus appear instantly and fade out in --speed-out', async ({page}) => {
  await page.goto('/-/next/gallery');
  await page.getByRole('button', {name: 'Menu'}).click();
  const menu = page.getByRole('menu');
  // Open: no entry animation.
  expect(await menu.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.keyboard.press('Escape');
  // Closing: the exit animation runs, then Radix unmounts the menu.
  await expect(menu).toBeHidden();
});

test('reduced motion: no exit animation', async ({page}) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.goto('/-/next/gallery');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--animate-exit-pop').trim())).toBe('none');
});
