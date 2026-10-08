// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Shared by the specs that run against a real Forgejo (NEXT_FORGEJO_URL):
// API v1 with basic auth, the PKCE sign-in through the classic pages, and a
// watch on page errors and CSP / Trusted Types violations.

import {expect, type Page} from '@playwright/test';

export const BASE = process.env.NEXT_FORGEJO_URL?.replace(/\/$/, '') ?? '';
export const USER = process.env.NEXT_FORGEJO_USER ?? 'dev';
export const PASSWORD = process.env.NEXT_FORGEJO_PASSWORD ?? 'devdevdev1';

export const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

export async function api(method: string, path: string, body?: object, as = basic(USER, PASSWORD)): Promise<Response> {
  return fetch(`${BASE}/api/v1${path}`, {
    method, headers: {'Authorization': as, 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {}),
  });
}

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
export async function signIn(page: Page, user = USER, password = PASSWORD): Promise<void> {
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
