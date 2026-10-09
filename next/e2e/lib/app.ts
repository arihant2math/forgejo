// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The app in a page: sign-in through the classic login and consent pages,
// a watch on page errors and CSP / Trusted Types violations, and the
// locators the specs share.

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

/** Signs in through the classic login and consent pages; ends on the app, live. */
export async function signIn(page: Page, user = DEV.user, password = DEV.password): Promise<void> {
  await page.goto(`${BASE}/-/next/`);
  await page.getByRole('button', {name: 'Sign in'}).click();
  await page.waitForURL(/\/user\/login|\/login\/oauth\/authorize/);
  if (page.url().includes('/user/login')) {
    await page.fill('#user_name', user);
    await page.fill('#password', password);
    await page.click('form button.primary');
  }
  await page.waitForURL(/\/login\/oauth\/authorize/);
  await page.locator('#authorize-app').click();
  await page.waitForURL(`${BASE}/`);
  await expect(page.getByRole('status').filter({hasText: /Live|Catching up/})).toBeVisible({timeout: 20_000});
}

/** A new page of `ctx`, signed in as `who`. */
export async function signedIn(ctx: BrowserContext, who: Who = DEV): Promise<Page> {
  const page = await ctx.newPage();
  await signIn(page, who.user, who.password);
  return page;
}

/** The sync indicator (a button: its text is the state and the pending count). */
export const indicator = (page: Page) => page.getByRole('button', {name: /: show unsynced changes$/});
export const sidebar = (page: Page) => page.getByRole('complementary', {name: 'Sidebar'});
export const issueList = (page: Page) => page.getByRole('listbox', {name: 'Issues'});
export const issueTitle = (page: Page) => page.getByRole('main').getByRole('heading', {level: 2});
export const activity = (page: Page) => page.getByRole('region', {name: 'Activity'});
/** A property row of the issue sidebar (Status, Labels, Assignees, …): its value. */
export const sidebarProp = (page: Page, name: string) =>
  page.getByRole('complementary', {name: 'Properties'}).locator('dt').filter({hasText: new RegExp(`^${name}$`)}).locator('xpath=following-sibling::dd[1]');

/** Opens the label picker (L) on the issue page and toggles `name`. */
export async function toggleLabel(page: Page, name: string): Promise<void> {
  await page.keyboard.press('l');
  await page.getByPlaceholder('Add or remove labels…').fill(name);
  await expect(page.getByRole('option', {name: new RegExp(`^${name}\\b`)})).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}
