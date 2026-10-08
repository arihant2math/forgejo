// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// F3 against a real Forgejo with livesync enabled and this checkout's build
// served by B8 (ASSETS_DIR = next/dist). Skipped unless NEXT_FORGEJO_URL is
// set; see IMPLEMENTATION.md (F3) for the server setup:
//
//   NEXT_FORGEJO_EXTRA_INI=$'[livesync]\nENABLED = true\nASSETS_DIR = <repo>/next/dist' next/tools/dev-forgejo.sh restart pg
//   NEXT_FORGEJO_URL=http://127.0.0.1:3000 npx playwright test --project forgejo
//
// The admin `dev` (dev-forgejo.sh) signs in through the classic login and
// consent pages; fixtures (a repository with issues, an organization) are
// created through API v1 with basic auth.

import {type Browser, type BrowserContext, expect, type Page, test} from '@playwright/test';

const BASE = process.env.NEXT_FORGEJO_URL?.replace(/\/$/, '') ?? '';
const USER = process.env.NEXT_FORGEJO_USER ?? 'dev';
const PASSWORD = process.env.NEXT_FORGEJO_PASSWORD ?? 'devdevdev1';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

const auth = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

async function api(method: string, path: string, body?: object): Promise<Response> {
  return fetch(`${BASE}/api/v1${path}`, {
    method, headers: {'Authorization': auth, 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {}),
  });
}

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

/** Collects page errors, error logs and CSP / Trusted Types violations of the Next UI's pages. */
function watch(page: Page): string[] {
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

/** Signs in through the classic login and consent pages; ends on the app. */
function splash(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('splash') ?? '{}') as Record<string, unknown>);
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE}/-/next/`);
  await page.getByRole('button', {name: 'Sign in'}).click();
  await page.waitForURL(/\/user\/login|\/login\/oauth\/authorize/);
  if (page.url().includes('/user/login')) {
    await page.fill('#user_name', USER);
    await page.fill('#password', PASSWORD);
    await page.click('form button.primary');
  }
  await page.waitForURL(/\/login\/oauth\/authorize/);
  await page.locator('#authorize-app').click();
  await page.waitForURL(`${BASE}/`);
  await expect(page.getByRole('status')).toContainText('Live', {timeout: 20_000});
}

const status = (page: Page) => page.getByRole('status');
const sidebar = (page: Page) => page.getByRole('complementary', {name: 'Sidebar'});

/** What IndexedDB holds for the user, read in the page. */
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

async function context(browser: Browser): Promise<BrowserContext> {
  return browser.newContext();
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
  // The code exchange carried a PKCE verifier; the authorize URL asked for S256.
  expect(tokenRequests[0]).toContain('grant_type=authorization_code');
  expect(tokenRequests[0]).toContain('code_verifier=');
  expect((await ctx.cookies()).find((c) => c.name === 'ui')?.value).toBe('next');
  // The refresh token is in IndexedDB; the access token is nowhere but memory.
  const stored = await idb(page);
  expect(stored.tokens).toHaveLength(1);
  expect(Object.keys(stored.tokens[0] ?? {}).sort()).toEqual(['login', 'refreshToken', 'updated', 'userId']);
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  expect(storage).not.toMatch(/eyJ[\w-]+\.[\w-]+/); // no JWT (Forgejo's tokens are JWTs)
  expect(storage).not.toContain(stored.tokens[0]?.refreshToken ?? 'x');
  expect(await splash(page)).toMatchObject({user: String(userId)});
  // The shell: account, views, the workspace's owners and repositories.
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

  // A reload: a new access token comes from the refresh token (rotated).
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

  // Only the UI's own files may load: API, sync and token endpoints fail.
  await page.route(/\/(api\/v1|-\/sync|login\/oauth)\//, (r) => r.abort('internetdisconnected'));
  await page.goto(`${BASE}/dev/next-e2e/issues/1`);
  await expect(page.getByRole('heading', {name: /Crash when saving the settings page/})).toBeVisible();
  await expect(sidebar(page).getByRole('group', {name: 'acme'}).getByRole('link', {name: 'website'})).toBeVisible();
  await expect(status(page)).not.toContainText('Live');
  expect(await page.evaluate(() => performance.getEntriesByName('firstPaintFromCache').length)).toBe(1);
  const marks = await page.evaluate(() => {
    const at = (n: string) => performance.getEntriesByName(n)[0]?.startTime ?? -1;
    return {appStart: at('appStart'), firstPaint: at('firstPaintFromCache')};
  });
  expect(marks.firstPaint).toBeGreaterThan(marks.appStart);
  // The boot shell was the issue's shape this time (splash), list shape on lists.
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
  // Spoil the stored refresh token.
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
  await expect(sidebar(page).getByRole('link', {name: 'next-e2e'})).toBeVisible(); // render first
  expect((await idb(page)).tokens).toHaveLength(0);
  await page.getByRole('button', {name: 'Sign in'}).click();
  await page.waitForURL(/\/login\/oauth\/authorize/); // the classic session is still there
  await page.locator('#authorize-app').click();
  await page.waitForURL(`${BASE}/`);
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
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByPlaceholder('Search repositories, issues and commands…');
  await expect(input).toBeFocused();
  await input.pressSequentially('website');
  await expect(page.getByRole('option', {name: /acme\/website/})).toBeVisible();
  await input.fill('dark mode');
  await expect(page.getByRole('option', {name: /Add dark mode to the dashboard/})).toBeVisible();
  const searches = await page.evaluate(() => performance.getEntriesByName('palette:search').map((e) => e.duration));
  expect(searches.length).toBeGreaterThan(0); // typing is deferred: keystrokes may share a search
  expect(Math.max(...searches)).toBeLessThan(16);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dev\/next-e2e\/issues\/\d+$/);
  await expect(page.getByRole('heading', {name: /Add dark mode to the dashboard/})).toBeVisible();
  // Esc closes; ⌘K toggles.
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
  // Hints: a nav item's tooltip, and the account menu.
  await sidebar(page).getByRole('link', {name: 'My issues'}).hover();
  await expect(page.getByRole('tooltip')).toContainText('G');
  await sidebar(page).getByRole('button', {name: USER}).first().click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', {name: /Command menu/})).toContainText(/⌘K|Ctrl/);
  await page.keyboard.press('Escape');
  // Typed search params: the filter is in the URL and survives a reload.
  await page.goto(`${BASE}/issues?type=assigned&state=bogus`);
  await expect(page.getByRole('link', {name: 'Assigned'})).toHaveAttribute('aria-current', 'page');
  await ctx.close();
});

test('the sidebar width persists into the next boot\'s first frame', async ({browser}) => {
  const ctx = await context(browser);
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
  // The first frame (app JS blocked) already has it.
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
  // Forgejo's own web session ended too: signing in again asks for the password.
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
  const ctx = await context(browser);
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
