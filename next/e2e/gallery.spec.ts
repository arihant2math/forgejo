// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The dev-only primitive gallery renders in both themes; floating surfaces use
// the theme tokens too. Screenshots land in test-results/ for review.

import {expect, test, type Page} from '@playwright/test';

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

/** Opens the gallery menu, closes it, and reports the exit animation and how long the menu stayed mounted. */
async function closeMenu(page: Page) {
  await page.goto('/-/next/gallery');
  await page.getByRole('button', {name: 'Menu'}).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const opening = await menu.evaluate((el) => getComputedStyle(el).animationName);
  return {
    opening,
    ...await page.evaluate(() => new Promise<{closing: string; duration: string; mountedMs: number}>((resolve) => {
      const el = document.querySelector('[role=menu]');
      if (!el) throw new Error('no menu');
      const t0 = performance.now();
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
      requestAnimationFrame(() => {
        const style = getComputedStyle(el);
        const result = {closing: style.animationName, duration: style.animationDuration};
        const check = () => {
          if (el.isConnected) requestAnimationFrame(check);
          else resolve({...result, mountedMs: performance.now() - t0});
        };
        check();
      });
    })),
  };
}

test('menus appear instantly and fade out in --speed-out', async ({page}) => {
  const r = await closeMenu(page);
  expect(r.opening).toBe('none'); // no entry animation
  expect(r.closing).toBe('exit-pop');
  expect(r.duration).toBe('0.15s');
  expect(r.mountedMs).toBeGreaterThanOrEqual(100);
  expect(r.mountedMs).toBeLessThan(1000);
});

test('reduced motion: menus close without an exit animation', async ({page}) => {
  await page.emulateMedia({reducedMotion: 'reduce'});
  const r = await closeMenu(page);
  expect(r.closing).not.toBe('exit-pop'); // '' when Radix unmounted it before the next frame
  expect(r.mountedMs).toBeLessThan(100);
});

test('a menu opened inside a dialog is on top and usable', async ({page}) => {
  await page.goto('/-/next/gallery');
  await page.getByRole('button', {name: 'Dialog'}).click();
  const dialog = page.getByRole('dialog', {name: 'Archive repository?'});
  await dialog.getByRole('button', {name: 'Labels'}).click();
  const item = page.getByRole('menuitem', {name: 'enhancement'});
  await expect(item).toBeVisible();
  const box = await item.boundingBox();
  if (!box) throw new Error('no box');
  const top = await page.evaluate(({x, y}) => document.elementFromPoint(x, y)?.closest('[role=menuitem]')?.textContent, {x: box.x + box.width / 2, y: box.y + box.height / 2});
  expect(top).toBe('enhancement');
  await item.click();
  await expect(item).toBeHidden();
  await expect(dialog).toBeVisible();
});

test('closing a menu does not pop its trigger\'s tooltip', async ({page}) => {
  await page.goto('/-/next/gallery');
  const trigger = page.getByRole('button', {name: 'More actions'});
  await trigger.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.waitForTimeout(800); // past the tooltip delay
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  // Keyboard focus that is not a return from the menu still shows it.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tooltip')).toHaveCount(1);
});
