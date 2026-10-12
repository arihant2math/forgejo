// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {type BrowserContext, expect, type Page} from '@playwright/test';
import {BASE, DEV, type Who} from './env.ts';

/** Collects page errors, error logs and CSP / Trusted Types violations of the Next UI's pages. */
export function watch(page: Page): string[] {
  const problems: string[] = [];
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // Classic pages (login, consent) have no built CSS/JS in the dev server: their 404s are not ours.
    const classic = new URL(page.url()).pathname.startsWith('/user/login') || page.url().includes('/login/oauth/');
    if (m.type() === 'error' && !classic && !m.text().includes('Failed to load resource')) problems.push(m.text());
  });
  return problems;
}

/** Own-site sign-in skips consent; dev redirect URIs require it. Ends on the app's home. */
export async function passConsent(page: Page): Promise<void> {
  const home = `${BASE}/`;
  await page.waitForURL((u) => u.href === home || u.pathname.endsWith('/login/oauth/authorize'));
  if (page.url() !== home) {
    await page.locator('#authorize-app').click();
    await page.waitForURL(home);
  }
}

/** Signs in through the classic login (and consent, where asked) pages; ends on the app, live. */
export async function signIn(page: Page, user = DEV.user, password = DEV.password): Promise<void> {
  await page.goto(`${BASE}/-/next/`);
  await page.getByRole('button', {name: 'Sign in'}).click();
  await page.waitForURL(/\/user\/login|\/login\/oauth\/authorize/);
  if (page.url().includes('/user/login')) {
    await page.fill('#user_name', user);
    await page.fill('#password', password);
    await page.click('form button.primary');
  }
  await passConsent(page);
  await expect(page.getByRole('status').filter({hasText: /Live|Catching up/})).toBeVisible({timeout: 20_000});
}

export async function signedIn(ctx: BrowserContext, who: Who = DEV): Promise<Page> {
  const page = await ctx.newPage();
  await signIn(page, who.user, who.password);
  return page;
}

/** The sync indicator: its state (the live region, also when Live hides the badge) and, when shown, the badge. */
export const indicator = (page: Page) => page.locator('[data-sync-indicator]');
/** The badge that opens "Unsynced changes" (shown unless Live with nothing waiting). */
export const unsyncedButton = (page: Page) => page.getByRole('button', {name: /: show unsynced changes$/});
export const sidebar = (page: Page) => page.getByRole('complementary', {name: 'Sidebar'});
export const issueList = (page: Page) => page.getByRole('listbox', {name: 'Issues'});
export const issueTitle = (page: Page) => page.getByRole('main').getByRole('heading', {level: 2});
export const activity = (page: Page) => page.getByRole('region', {name: 'Activity'});
export const sidebarProp = (page: Page, name: string) =>
  page.getByRole('complementary', {name: 'Properties'}).locator('dt').filter({hasText: new RegExp(`^${name}$`)}).locator('xpath=following-sibling::dd[1]');

export async function toggleLabel(page: Page, name: string): Promise<void> {
  await page.keyboard.press('l');
  await page.getByPlaceholder('Add or remove labels…').fill(name);
  await expect(page.getByRole('option', {name: new RegExp(`^${name}\\b`)})).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}
