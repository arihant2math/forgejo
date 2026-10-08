// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// F5 against a real Forgejo with livesync serving this build (forgejo.spec.ts
// has the server setup): offline edits — labels, the description, comments —
// while a second user edits the same issue, then reconnecting converges with
// no duplicates; the description conflict resolved in the editor; a warm
// boot offline from the service worker; two tabs with the leader closed in
// the middle of a flush; the service worker's update path and kill switch.
// Seeded with tools/seed-issues.ts (repository f5).

import {execFileSync} from 'node:child_process';
import {readFileSync, renameSync, utimesSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {type BrowserContext, expect, type Page, test} from '@playwright/test';
import {api, BASE, basic, signIn, USER, watch} from './helpers.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

const REPO = 'f5';
const ALICE = {user: 'alice', password: 'alicealice1'};
const alice = basic(ALICE.user, ALICE.password);
const DIST = resolve(process.cwd(), 'dist');

interface ApiIssue {
  number: number;
  id: number;
  title: string;
  body: string;
  labels: {name: string}[];
}

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  execFileSync('node', ['tools/seed-issues.ts', '--url', BASE, '--repo', REPO, '--issues', '12'], {stdio: 'inherit'});
  // alice may write here (the seed makes her a collaborator of the repository).
  await api('PUT', `/repos/${USER}/${REPO}/collaborators/alice`, {permission: 'write'});
});

/** A fresh open issue with a known body, for one test. */
async function freshIssue(title: string): Promise<ApiIssue> {
  const res = await api('POST', `/repos/${USER}/${REPO}/issues`, {title, body: 'Line one.\n\nLine two.\n\nLine three.'});
  expect(res.status).toBe(201);
  return await res.json() as ApiIssue;
}

async function issue(n: number): Promise<ApiIssue> {
  return await (await api('GET', `/repos/${USER}/${REPO}/issues/${String(n)}`)).json() as ApiIssue;
}

async function comments(n: number): Promise<string[]> {
  const list = await (await api('GET', `/repos/${USER}/${REPO}/issues/${String(n)}/comments`)).json() as {body: string}[];
  return list.map((c) => c.body);
}

async function signedIn(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await signIn(page);
  return page;
}

/** The sync indicator (a button: its text is the state and the pending count). */
const indicator = (page: Page) => page.getByRole('button', {name: /: show unsynced changes$/});
const sidebarProp = (page: Page, name: string) =>
  page.getByRole('complementary', {name: 'Properties'}).locator('dt').filter({hasText: new RegExp(`^${name}$`)}).locator('xpath=following-sibling::dd[1]');
const activity = (page: Page) => page.getByRole('region', {name: 'Activity'});

/** Waits until the service worker controls the page and has this build cached. */
async function swReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    return Boolean(reg?.active && navigator.serviceWorker.controller) && keys.some((k) => k.startsWith('forgejo-next-'));
  }), {timeout: 30_000}).toBe(true);
}

/** Whether this device holds the repository's group (stored once its bootstrap finished, not while on screen only). */
async function stored(page: Page, owner: string, repo: string): Promise<boolean> {
  const {id} = await (await api('GET', `/repos/${owner}/${repo}`)).json() as {id: number};
  return await page.evaluate(async (group) => {
    const name = (await indexedDB.databases()).map((d) => d.name).find((n) => n?.startsWith('forgejo-next:'));
    if (!name) return false;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => {
        resolve(r.result);
      };
      r.onerror = () => {
        reject(r.error ?? new Error('open failed'));
      };
    });
    const key = await new Promise<IDBValidKey | undefined>((resolve) => {
      const r = db.transaction('meta').objectStore('meta').getKey(group);
      r.onsuccess = () => {
        resolve(r.result);
      };
    });
    db.close();
    return key !== undefined;
  }, `group:repo:${String(id)}`);
}

async function goOffline(ctx: BrowserContext, page: Page): Promise<void> {
  await ctx.setOffline(true);
  await expect(indicator(page)).toContainText('Offline', {timeout: 10_000});
}

async function goOnline(ctx: BrowserContext, page: Page): Promise<void> {
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

async function addLabel(page: Page, name: string): Promise<void> {
  await page.keyboard.press('l');
  await page.getByPlaceholder('Add or remove labels…').fill(name);
  await expect(page.getByRole('option', {name: new RegExp(`^${name}\\b`)})).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}

test('offline edits (labels, description, comments) while another user edits the same issue converge with no duplicates', async ({browser}) => {
  const target = await freshIssue(`Offline edits ${String(Date.now())}`);
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  await page.goto(`${BASE}/${USER}/${REPO}/issues/${String(target.number)}`);
  await expect(page.locator('.prose').first()).toContainText('Line one.', {timeout: 20_000});

  await goOffline(ctx, page);
  await addLabel(page, 'docs');
  await expect(sidebarProp(page, 'Labels')).toContainText('docs');
  await page.getByRole('button', {name: 'Edit the description'}).click();
  await page.getByRole('textbox', {name: 'Description'}).fill('Line one, edited offline.\n\nLine two.\n\nLine three.');
  await page.getByRole('button', {name: 'Save'}).click();
  await expect(page.getByText('Line one, edited offline.')).toBeVisible();
  await expect(page.getByText('Not synced').first()).toBeVisible();
  const mine = `My offline comment ${String(Date.now())}`;
  await page.getByRole('textbox', {name: 'Leave a comment'}).fill(mine);
  await page.getByRole('button', {name: 'Comment', exact: true}).click();
  await expect(activity(page)).toContainText(mine);
  await expect(indicator(page)).toContainText('3 pending');

  // Meanwhile alice edits the same issue: another line of the description, a label, a comment.
  const body = await issue(target.number);
  expect((await api('PATCH', `/repos/${USER}/${REPO}/issues/${String(target.number)}`, {body: body.body.replace('Line three.', 'Line three, by alice.')}, alice)).ok).toBe(true);
  expect((await api('POST', `/repos/${USER}/${REPO}/issues/${String(target.number)}/labels`, {labels: ['ux']}, alice)).ok).toBe(true);
  const hers = `Alice was here ${String(Date.now())}`;
  expect((await api('POST', `/repos/${USER}/${REPO}/issues/${String(target.number)}/comments`, {body: hers}, alice)).status).toBe(201);

  await goOnline(ctx, page);
  await expect(indicator(page)).toContainText('Live', {timeout: 20_000});
  await expect(indicator(page)).not.toContainText('pending', {timeout: 20_000});
  // The server: the description merged (both lines), both labels, each comment once.
  const after = await issue(target.number);
  expect(after.body).toBe('Line one, edited offline.\n\nLine two.\n\nLine three, by alice.');
  expect(after.labels.map((l) => l.name).sort()).toEqual(expect.arrayContaining(['docs', 'ux']));
  const all = await comments(target.number);
  expect(all.filter((c) => c === mine)).toHaveLength(1);
  expect(all.filter((c) => c === hers)).toHaveLength(1);
  // The page: the server's rendering, no pending marks.
  await expect(page.locator('.prose').first()).toContainText('Line three, by alice.', {timeout: 10_000});
  await expect(page.getByText('Not synced')).toHaveCount(0);
  await expect(activity(page)).toContainText(hers);
  expect(problems).toEqual([]);
  await ctx.close();
});

test('a description conflict is shown in the editor and resolved there', async ({browser}) => {
  const target = await freshIssue(`Conflict ${String(Date.now())}`);
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(`${BASE}/${USER}/${REPO}/issues/${String(target.number)}`);
  await expect(page.locator('.prose').first()).toContainText('Line one.', {timeout: 20_000});
  await goOffline(ctx, page);
  await page.getByRole('button', {name: 'Edit the description'}).click();
  await page.getByRole('textbox', {name: 'Description'}).fill('Line one, MINE.\n\nLine two.\n\nLine three.');
  await page.getByRole('button', {name: 'Save'}).click();
  expect((await api('PATCH', `/repos/${USER}/${REPO}/issues/${String(target.number)}`, {body: 'Line one, THEIRS.\n\nLine two.\n\nLine three.'}, alice)).ok).toBe(true);
  await goOnline(ctx, page);
  const callout = page.getByRole('main').getByRole('note').filter({hasText: 'Your edit conflicts with a newer change'});
  await expect(callout).toBeVisible({timeout: 20_000});
  const editor = page.getByRole('textbox', {name: 'Resolve the description'});
  // The CodeMirror editor (F6): its lines as text.
  await expect.poll(() => editor.evaluate((el) => (el as HTMLElement).innerText)).toMatch(/<<<<<<< yours\nLine one, MINE\.\n=======\nLine one, THEIRS\.\n>>>>>>> theirs/);
  // Saving is refused while markers are left.
  await expect(page.getByRole('button', {name: 'Save'})).toBeDisabled();
  await editor.fill('Line one, MINE and THEIRS.\n\nLine two.\n\nLine three.');
  await page.getByRole('button', {name: 'Save'}).click();
  await expect(callout).toHaveCount(0);
  await expect.poll(async () => (await issue(target.number)).body, {timeout: 20_000}).toBe('Line one, MINE and THEIRS.\n\nLine two.\n\nLine three.');
  await ctx.close();
});

test('a warm boot offline renders the list from the service worker and IndexedDB in under 300 ms', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(`${BASE}/${USER}/${REPO}/issues`);
  await expect(page.getByRole('listbox', {name: 'Issues'}).getByRole('option').first()).toBeVisible({timeout: 20_000});
  await swReady(page);
  // Warm: the repository is on this device (its group stored), not only on screen.
  await expect.poll(() => stored(page, USER, REPO), {timeout: 30_000}).toBe(true);
  await ctx.setOffline(true);
  // The first boot served by the worker fills the browser's code cache for its responses (measured and logged
  // only: ≈ 200–350 ms here); the warm boots after it are the target.
  const times: number[] = [];
  for (let run = 0; run < 4; run++) {
    const resp = await page.reload();
    expect(resp?.fromServiceWorker()).toBe(true);
    await expect(page.getByRole('listbox', {name: 'Issues'}).getByRole('option').first()).toBeVisible();
    times.push(await page.evaluate(() => performance.getEntriesByName('firstPaintFromCache')[0]?.startTime ?? Number.NaN));
  }
  console.log('offline boot firstPaintFromCache (ms), first from the worker then warm:', times.map((t) => Math.round(t)));
  test.info().annotations.push({type: 'offlineWarmBootMs', description: JSON.stringify(times.map((t) => Math.round(t)))});
  expect(Math.max(...times.slice(1))).toBeLessThan(300);
  // A page the app does not have offline says so and lists what is available (no blank screen).
  await page.goto(`${BASE}/${USER}/${REPO}/wiki`);
  await expect(page.getByText('Not available offline')).toBeVisible();
  await expect(page.getByRole('navigation', {name: 'Available on this device'})).toContainText('My issues');
  await ctx.close();
});

test('two tabs: the follower’s offline comment is flushed once even when the leader closes in the middle of sending it', async ({browser}) => {
  const target = await freshIssue(`Two tabs ${String(Date.now())}`);
  const ctx = await browser.newContext();
  const leader = await signedIn(ctx);
  const path = `${BASE}/${USER}/${REPO}/issues/${String(target.number)}`;
  await leader.goto(path);
  const follower = await ctx.newPage();
  await follower.goto(path);
  await expect(follower.locator('.prose').first()).toContainText('Line one.', {timeout: 20_000});
  await goOffline(ctx, follower);
  const text = `From the follower ${String(Date.now())}`;
  await follower.getByRole('textbox', {name: 'Leave a comment'}).fill(text);
  await follower.getByRole('button', {name: 'Comment', exact: true}).click();
  await expect(activity(follower)).toContainText(text);
  // The leader's request reaches Forgejo, and the leader closes before it gets the answer.
  let sent = 0;
  await leader.route(/\/api\/v1\/repos\/.*\/issues\/\d+\/comments$/, async (r) => {
    sent++;
    await r.fetch(); // the server creates the comment…
    await leader.close({runBeforeUnload: false}); // …and the tab dies before reading the answer
  });
  await ctx.setOffline(false);
  await follower.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => sent, {timeout: 20_000}).toBeGreaterThan(0);
  // The follower takes over and sends it again under the same key: Forgejo replays the answer.
  await expect(indicator(follower)).not.toContainText('pending', {timeout: 30_000});
  expect((await comments(target.number)).filter((c) => c === text)).toHaveLength(1);
  await ctx.close();
});

test('the service worker update path: a new build waits, "Reload" activates it', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(`${BASE}/${USER}/${REPO}/issues`);
  await swReady(page);
  const index = resolve(DIST, 'index.html');
  const sw = resolve(DIST, 'sw.js');
  const htmlBefore = readFileSync(index, 'utf8');
  const swBefore = readFileSync(sw, 'utf8');
  const version = /<meta name="forgejo-next-build" content="([\w-]+)"/.exec(htmlBefore)?.[1] ?? '';
  expect(version).not.toBe('');
  const next = `${version.slice(0, 10)}e2e001`;
  try {
    // A "new build": the same assets under a new version (index.html changes, so B8 serves it afresh).
    writeFileSync(sw, swBefore.replaceAll(version, next));
    writeFileSync(index, htmlBefore.replaceAll(version, next));
    utimesSync(index, new Date(), new Date());
    await page.reload();
    const notice = page.getByRole('status').filter({hasText: 'A new version is ready'});
    await expect(notice).toBeVisible({timeout: 30_000});
    await notice.getByRole('button', {name: 'Reload'}).click();
    await page.waitForLoadState('load');
    // The page reloads into the new build; its old build's cache is gone.
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('forgejo-next-'))).catch(() => []), {timeout: 30_000})
      .toEqual([`forgejo-next-${next}`]);
    await expect.poll(() => page.evaluate(() => document.querySelector('meta[name="forgejo-next-build"]')?.getAttribute('content')).catch(() => ''), {timeout: 30_000}).toBe(next);
  } finally {
    writeFileSync(sw, swBefore);
    writeFileSync(index, htmlBefore);
    utimesSync(index, new Date(), new Date());
  }
  await ctx.close();
});

test('the kill switch: no sw.js served ⇒ the worker unregisters itself and drops its caches', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(`${BASE}/${USER}/${REPO}/issues`);
  await swReady(page);
  const sw = resolve(DIST, 'sw.js');
  const index = resolve(DIST, 'index.html');
  renameSync(sw, `${sw}.off`);
  utimesSync(index, new Date(), new Date());
  try {
    await page.reload();
    await expect.poll(() => page.evaluate(async () => ({
      regs: (await navigator.serviceWorker.getRegistrations()).length,
      caches: (await caches.keys()).filter((k) => k.startsWith('forgejo-next-')).length,
    })), {timeout: 30_000}).toEqual({regs: 0, caches: 0});
  } finally {
    renameSync(`${sw}.off`, sw);
    utimesSync(index, new Date(), new Date());
  }
  await ctx.close();
});
