// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Offline (F5) against a real Forgejo with livesync serving this build:
// offline edits — labels, the description, comments — while a second user
// edits the same issue, then reconnecting converges with no duplicates; the
// description conflict resolved in the editor; "not available offline"; two
// tabs with the leader closed in the middle of a flush; the service worker's
// update path and kill switch. (The offline warm boot is timed in perf.spec.ts.)
// Seeded with tools/seed-issues.ts (repository f5).

import {readFileSync, renameSync, utimesSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {expect, test} from '@playwright/test';
import {api, type ApiIssue, newIssue, seed} from '../lib/api.ts';
import {activity, indicator, sidebarProp, signedIn, toggleLabel as addLabel, watch} from '../lib/app.ts';
import {goOffline, goOnline, storedGroup, swReady} from '../lib/device.ts';
import {aliceAuth as alice, BASE, DIST, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

const REPO = 'f5';

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  seed(REPO, 12);
  // alice may write here (the seed makes her a collaborator of the repository).
  await api('PUT', `/repos/${USER}/${REPO}/collaborators/alice`, {permission: 'write'});
});

/** A fresh open issue with a known body, for one test. */
const freshIssue = (title: string) => newIssue(USER, REPO, title, 'Line one.\n\nLine two.\n\nLine three.');

async function issue(n: number): Promise<ApiIssue> {
  return await (await api('GET', `/repos/${USER}/${REPO}/issues/${String(n)}`)).json() as ApiIssue;
}

async function comments(n: number): Promise<string[]> {
  const list = await (await api('GET', `/repos/${USER}/${REPO}/issues/${String(n)}/comments`)).json() as {body: string}[];
  return list.map((c) => c.body);
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

test('a page the app does not have offline says so and lists what is available', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(`${BASE}/${USER}/${REPO}/issues`);
  await expect(page.getByRole('listbox', {name: 'Issues'}).getByRole('option').first()).toBeVisible({timeout: 20_000});
  await swReady(page);
  await expect.poll(async () => storedGroup(page, `repo:${String((await (await api('GET', `/repos/${USER}/${REPO}`)).json() as {id: number}).id)}`), {timeout: 30_000}).toBe(true);
  await ctx.setOffline(true);
  // No blank screen, no spinner: what is on this device.
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
    // The page reloads into the new build; its old build's cache is gone (the avatars' cache is kept across builds).
    await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('forgejo-next-') && k !== 'forgejo-next-avatars')).catch(() => []), {timeout: 30_000})
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
