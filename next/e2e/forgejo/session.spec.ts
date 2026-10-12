// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {type Browser, type BrowserContext, expect, type Page, test} from '@playwright/test';
import {api} from '../lib/api.ts';
import {passConsent, sidebar, signIn, watch} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

let userId = 0;

test.beforeAll(async () => {
  const me = await (await api('GET', '/user')).json() as {id: number};
  userId = me.id;
  await api('POST', '/user/repos', {name: 'next-e2e', auto_init: true});
  await api('POST', '/orgs', {username: 'acme'});
  for (const r of ['website', 'api', 'docs']) await api('POST', '/orgs/acme/repos', {name: r, auto_init: true});
  const issues = await (await api('GET', '/repos/dev/next-e2e/issues?state=all&limit=50')).json() as {title: string}[];
  for (const title of ['Crash when saving the settings page', 'Add dark mode to the dashboard']) {
    if (!issues.some((i) => i.title === title)) await api('POST', '/repos/dev/next-e2e/issues', {title});
  }
});

function splash(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('splash') ?? '{}') as Record<string, unknown>);
}

const status = (page: Page) => page.getByRole('status');

function idb(page: Page) {
  return page.evaluate(async (uid) => {
    const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => {
        resolve(r.result);
      };
      r.onerror = () => {
        reject(new Error(String(r.error)));
      };
    });
    const all = (db: IDBDatabase, store: string) => new Promise<unknown[]>((resolve) => {
      if (!db.objectStoreNames.contains(store)) {
        resolve([]);
        return;
      }
      const r = db.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => {
        resolve(r.result);
      };
    });
    const names = (await indexedDB.databases()).map((d) => d.name ?? '');
    let tokens: unknown[] = [];
    let repos = 0;
    if (names.includes('forgejo-next-auth')) {
      const db = await open('forgejo-next-auth');
      tokens = await all(db, 'tokens');
      db.close();
    }
    if (names.includes(`forgejo-next:${String(uid)}`)) {
      const db = await open(`forgejo-next:${String(uid)}`);
      repos = (await all(db, 'm:Repository') as {r: unknown[]}[]).reduce((n, v) => n + v.r.length, 0);
      db.close();
    }
    return {names, tokens: tokens as {userId: number; refreshToken: string; login: string}[], repos};
  }, userId);
}

/** `noWorker` lets routed requests reach the network rather than the service worker cache. */
async function context(browser: Browser, {noWorker = false} = {}): Promise<BrowserContext> {
  return browser.newContext(noWorker ? {serviceWorkers: 'block'} : {});
}

test('sign in with PKCE through the classic consent page: tokens, opt-in cookie, the shell', async ({browser}) => {
  const ctx = await context(browser);
  const page = await ctx.newPage();
  const problems = watch(page);
  const tokenRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/login/oauth/access_token')) tokenRequests.push(r.postData() ?? '');
  });
  await signIn(page);
  expect(tokenRequests[0]).toContain('grant_type=authorization_code');
  expect(tokenRequests[0]).toContain('code_verifier=');
  expect((await ctx.cookies()).find((c) => c.name === 'ui')?.value).toBe('next');
  const stored = await idb(page);
  expect(stored.tokens).toHaveLength(1);
  expect(Object.keys(stored.tokens[0] ?? {}).sort()).toEqual(['login', 'refreshToken', 'updated', 'userId']);
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  expect(storage).not.toMatch(/eyJ[\w-]+\.[\w-]+/);
  expect(storage).not.toContain(stored.tokens[0]?.refreshToken ?? 'x');
  expect(await splash(page)).toMatchObject({user: String(userId)});
  await expect(sidebar(page).getByRole('link', {name: 'next-e2e'})).toBeVisible({timeout: 15_000});
  await expect(sidebar(page).getByRole('group', {name: 'acme'}).getByRole('link', {name: 'website'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Home'})).toBeVisible();
  expect(problems).toEqual([]);
  await ctx.close();
});

test('warm boot renders from IndexedDB with the network to Forgejo\'s data blocked; refresh rotates the token', async ({browser}) => {
  const ctx = await context(browser);
  const page = await ctx.newPage();
  const problems = watch(page);
  await signIn(page);
  await expect(sidebar(page).getByRole('link', {name: 'next-e2e'})).toBeVisible({timeout: 15_000});
  await expect.poll(async () => (await idb(page)).repos).toBeGreaterThan(0);
  const before = (await idb(page)).tokens[0]?.refreshToken;

  const refreshes: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/login/oauth/access_token')) refreshes.push(r.postData() ?? '');
  });
  await page.reload();
  await expect(status(page)).toContainText('Live', {timeout: 20_000});
  expect(refreshes).toHaveLength(1);
  expect(refreshes[0]).toContain('grant_type=refresh_token');
  const after = (await idb(page)).tokens[0]?.refreshToken;
  expect(after).toBeTruthy();
  expect(after).not.toBe(before);

  await page.route(/\/(api\/v1|-\/sync|login\/oauth)\//, (r) => r.abort('internetdisconnected'));
  await page.goto(`${BASE}/dev/next-e2e/issues/1`);
  await expect(page.getByRole('heading', {level: 1, name: /Crash when saving the settings page/})).toBeVisible();
  await expect(sidebar(page).getByRole('group', {name: 'acme'}).getByRole('link', {name: 'website'})).toBeVisible();
  await expect(status(page)).not.toContainText('Live');
  expect(await page.evaluate(() => performance.getEntriesByName('firstPaintFromCache').length)).toBe(1);
  const marks = await page.evaluate(() => {
    const at = (n: string) => performance.getEntriesByName(n)[0]?.startTime ?? -1;
    return {appStart: at('appStart'), firstPaint: at('firstPaintFromCache')};
  });
  expect(marks.firstPaint).toBeGreaterThan(marks.appStart);
  expect(await splash(page)).toMatchObject({route: '/dev/next-e2e/issues/1', skeleton: {shape: 'detail'}});
  await page.unroute(/\/(api\/v1|-\/sync|login\/oauth)\//);
  await expect(status(page)).toContainText('Live', {timeout: 30_000});
  expect(problems.filter((p) => !p.includes('net::ERR_INTERNET_DISCONNECTED'))).toEqual([]);
  await ctx.close();
});

test('a refused refresh token: still rendered from local data, "Signed out", and signing in again resumes', async ({browser}) => {
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await signIn(page);
  await expect(sidebar(page).getByRole('link', {name: 'next-e2e'})).toBeVisible({timeout: 15_000});
  await expect.poll(async () => (await idb(page)).repos).toBeGreaterThan(0);
  // Wait for this repository's group to persist; bootstraps are stored group by group.
  await expect.poll(() => page.evaluate(async (uid) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(`forgejo-next:${String(uid)}`);
      r.onsuccess = () => {
        resolve(r.result);
      };
      r.onerror = () => {
        reject(new Error('open'));
      };
    });
    const v = await new Promise<unknown>((resolve) => {
      const r = db.transaction('m:Repository').objectStore('m:Repository').getAll();
      r.onsuccess = () => {
        resolve(r.result);
      };
    });
    db.close();
    return JSON.stringify(v).includes('"next-e2e"');
  }, userId), {timeout: 30_000}).toBe(true);
  await page.evaluate(async (uid) => {
    await new Promise<void>((resolve) => {
      const r = indexedDB.open('forgejo-next-auth');
      r.onsuccess = () => {
        const tx = r.result.transaction('tokens', 'readwrite');
        const store = tx.objectStore('tokens');
        const g = store.get(uid);
        g.onsuccess = () => {
          store.put({...g.result as object, refreshToken: 'spoiled'});
        };
        tx.oncomplete = () => {
          r.result.close();
          resolve();
        };
      };
    });
  }, userId);
  await page.reload();
  await expect(status(page)).toContainText('Signed out', {timeout: 20_000});
  await expect(sidebar(page).getByRole('link', {name: 'next-e2e'})).toBeVisible();
  expect((await idb(page)).tokens).toHaveLength(0);
  await page.getByRole('button', {name: 'Sign in'}).click();
  await passConsent(page);
  await expect(status(page)).toContainText('Live', {timeout: 20_000});
  await ctx.close();
});

test('the sync indicator follows the connection', async ({browser}) => {
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await signIn(page);
  await ctx.setOffline(true);
  await expect(status(page)).toContainText('Offline', {timeout: 15_000});
  await ctx.setOffline(false);
  await expect(status(page)).toContainText('Live', {timeout: 30_000});
  await ctx.close();
});

test('⌘K finds a repository and an issue from the pool within a frame, and opens them', async ({browser}) => {
  const ctx = await context(browser);
  const page = await ctx.newPage();
  const problems = watch(page);
  await signIn(page);
  await expect(sidebar(page).getByRole('link', {name: 'next-e2e'})).toBeVisible({timeout: 15_000});
  // Wait for the repository to reach the pool before searching it.
  await expect(sidebar(page).getByRole('group', {name: 'acme'}).getByRole('link', {name: 'website'})).toBeVisible({timeout: 15_000});
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByPlaceholder(/^Search repositories, issues/);
  await expect(input).toBeFocused();
  await input.pressSequentially('website');
  await expect(page.getByRole('option', {name: /acme\/website/})).toBeVisible();
  // Avoid the theme command's alias, which would rank first for "dark mode".
  await input.fill('add dark mode');
  await expect(page.getByRole('option', {name: /Add dark mode to the dashboard/})).toBeVisible();
  const searches = await page.evaluate(() => performance.getEntriesByName('palette:search').map((e) => e.duration));
  expect(searches.length).toBeGreaterThan(0);
  expect(Math.max(...searches)).toBeLessThan(16);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dev\/next-e2e\/issues\/\d+$/);
  await expect(page.getByRole('heading', {level: 1, name: /Add dark mode to the dashboard/})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(input).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  expect(problems).toEqual([]);
  await ctx.close();
});

test('keyboard: G I / G P / G N, ? for the shortcuts, and hints in tooltips and menus', async ({browser}) => {
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await signIn(page);
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  await expect(page).toHaveURL(`${BASE}/issues`);
  await expect(page.getByRole('heading', {name: 'My issues'})).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page).toHaveURL(`${BASE}/pulls`);
  await page.keyboard.press('g');
  await page.keyboard.press('n');
  await expect(page).toHaveURL(`${BASE}/notifications`);
  await page.keyboard.press('Shift+?');
  const help = page.getByRole('dialog', {name: 'Keyboard shortcuts'});
  await expect(help.getByText('Go to my issues')).toBeVisible();
  await page.keyboard.press('Escape');
  await sidebar(page).getByRole('link', {name: 'My issues'}).hover();
  await expect(page.getByRole('tooltip')).toContainText('G');
  await sidebar(page).getByRole('button', {name: USER}).first().click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', {name: /Command menu/})).toContainText(/⌘K|Ctrl/);
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/issues?type=assigned&state=bogus`);
  await expect(page.getByRole('link', {name: 'Assigned'})).toHaveAttribute('aria-current', 'page');
  await ctx.close();
});

test('the sidebar width persists into the next boot\'s first frame', async ({browser}) => {
  const ctx = await context(browser, {noWorker: true});
  const page = await ctx.newPage();
  await signIn(page);
  const handle = page.getByRole('separator', {name: 'Resize the sidebar'});
  const box = await handle.boundingBox();
  if (!box) throw new Error('no handle');
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + 200, {steps: 4});
  await page.mouse.up();
  const width = await sidebar(page).evaluate((el) => el.getBoundingClientRect().width);
  expect((await splash(page)).sidebarWidth).toBe(Math.round(width));
  const shell = await ctx.newPage();
  await shell.route('**/-/next/assets/*.js', (r) => r.abort());
  await shell.goto(`${BASE}/`);
  expect(await shell.locator('aside').first().evaluate((el) => el.getBoundingClientRect().width)).toBe(Math.round(width));
  await ctx.close();
});

test('sign-out in one tab signs out every tab and wipes local data', async ({browser}) => {
  const ctx = await context(browser);
  const a = await ctx.newPage();
  await signIn(a);
  const b = await ctx.newPage();
  await b.goto(`${BASE}/issues`);
  await expect(b.getByRole('heading', {name: 'My issues'})).toBeVisible();
  await expect.poll(async () => (await idb(a)).repos).toBeGreaterThan(0);
  await sidebar(a).getByRole('button', {name: USER}).first().click();
  await a.getByRole('menuitem', {name: 'Sign out'}).click();
  for (const p of [a, b]) await expect(p.getByText('Sign in to continue.')).toBeVisible({timeout: 15_000});
  const left = await idb(a);
  expect(left.names).not.toContain(`forgejo-next:${String(userId)}`);
  expect(left.tokens).toEqual([]);
  expect((await splash(a)).user).toBeUndefined();
  expect(await a.evaluate(() => localStorage.getItem('forgejo-next:wipe'))).toBeNull();
  expect((await ctx.request.get(`${BASE}/user/settings`, {maxRedirects: 0})).status()).not.toBe(200);
  expect((await splash(a)).route).toBeUndefined();
  await ctx.close();
});

test('sign-out warns about unsynced intents first', async ({browser}) => {
  const ctx = await context(browser);
  const page = await ctx.newPage();
  await signIn(page);
  await page.evaluate(async (uid) => {
    await new Promise<void>((resolve) => {
      const r = indexedDB.open(`forgejo-next:${String(uid)}`);
      r.onsuccess = () => {
        const tx = r.result.transaction('intents', 'readwrite');
        tx.objectStore('intents').add({kind: 'issue.addLabel', issueId: 1, labelId: 1});
        tx.oncomplete = () => {
          r.result.close();
          resolve();
        };
      };
    });
  }, userId);
  await sidebar(page).getByRole('button', {name: USER}).first().click();
  await page.getByRole('menuitem', {name: 'Sign out'}).click();
  const dialog = page.getByRole('dialog', {name: 'Sign out with unsynced changes?'});
  await expect(dialog).toContainText('1 change has not reached Forgejo yet');
  await dialog.getByRole('button', {name: 'Cancel'}).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toBeVisible();
  await sidebar(page).getByRole('button', {name: USER}).first().click();
  await page.getByRole('menuitem', {name: 'Sign out'}).click();
  await page.getByRole('button', {name: 'Sign out anyway'}).click();
  await expect(page.getByText('Sign in to continue.')).toBeVisible({timeout: 15_000});
  expect((await idb(page)).names).not.toContain(`forgejo-next:${String(userId)}`);
  await ctx.close();
});

test('signing in in one tab brings a logged-out tab in', async ({browser}) => {
  const ctx = await context(browser);
  const idle = await ctx.newPage();
  await idle.goto(`${BASE}/-/next/`);
  await expect(idle.getByText('Sign in to continue.')).toBeVisible();
  const page = await ctx.newPage();
  await signIn(page);
  await expect(idle.getByRole('status')).toBeVisible({timeout: 15_000});
  await ctx.close();
});

test('the signed-in boot shell has the app shell\'s geometry (no shift when React mounts)', async ({browser}) => {
  const ctx = await context(browser, {noWorker: true});
  const page = await ctx.newPage();
  await signIn(page);
  const boxes = async (p: Page) => Promise.all([
    p.locator('aside:visible').first().boundingBox(),
    p.locator('main:visible header').first().boundingBox(),
    p.locator('aside:visible > div').first().boundingBox(), // account + search rows
  ]);
  const mounted = await boxes(page);
  const frozen = await ctx.newPage();
  await frozen.route('**/-/next/assets/*.js', (r) => r.abort());
  await frozen.goto(`${BASE}/`);
  expect(await boxes(frozen)).toEqual(mounted);
  await ctx.close();
});
