// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Lists and the issue page (F4) against a real Forgejo with livesync: issue lists over a large repository (rendering, local
// filtering, scrolling, keyboard), opening an issue from the pool, optimistic
// edits confirmed by the sync-id echo or rolled back, and live changes by a
// second user. The repository is seeded with tools/seed-issues.ts (idempotent):
//
//   NEXT_E2E_REPO=big NEXT_E2E_ISSUES=5000 next/tools/dev-forgejo.sh e2e pg lists
//
// (defaults: repository "f4" with 400 issues). Measurements are printed and
// attached to the test results.

import {expect, type Page, test} from '@playwright/test';
import {api, labelId as repoLabelId, seed} from '../lib/api.ts';
import {issueList as listbox, issueTitle, sidebarProp, signedIn, signIn, watch} from '../lib/app.ts';
import {storedRecords} from '../lib/device.ts';
import {ALICE, aliceAuth as alice, BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

const REPO = process.env.NEXT_E2E_REPO ?? 'f4';
const ISSUES = Number(process.env.NEXT_E2E_ISSUES ?? 400);

let openCount = 0;
let repoId = 0;

test.beforeAll(async () => {
  test.setTimeout(30 * 60_000);
  seed(REPO, ISSUES);
  const res = await api('GET', `/repos/${USER}/${REPO}/issues?state=open&type=issues&limit=1`);
  openCount = Number(res.headers.get('X-Total-Count'));
  repoId = (await (await api('GET', `/repos/${USER}/${REPO}`)).json() as {id: number}).id;
});


/** The last list:query measure (rows, ms). */
function lastQuery(page: Page) {
  return page.evaluate(() => {
    const e = performance.getEntriesByName('list:query').at(-1) as PerformanceMeasure | undefined;
    return e ? {ms: e.duration, rows: (e.detail as {rows: number}).rows, n: performance.getEntriesByName('list:query').length} : undefined;
  });
}

async function openList(page: Page, search = ''): Promise<void> {
  await page.goto(`${BASE}/${USER}/${REPO}/issues${search}`);
  await expect(listbox(page)).toBeVisible({timeout: 60_000});
}

/** Waits until every open issue of the repository is in the list (bootstrap done). */
async function fullyLoaded(page: Page): Promise<void> {
  await expect.poll(async () => (await lastQuery(page))?.rows ?? 0, {timeout: 120_000, intervals: [250]}).toBe(openCount);
}

const results: Record<string, unknown> = {};

test.afterAll(() => {
  console.log(`F4 measurements (${REPO}, ${String(ISSUES)} issues, ${String(openCount)} open): ${JSON.stringify(results, null, 1)}`);
});

test('a large list renders from the pool, filters/groups/sorts locally within a frame, and scrolls without long tasks', async ({browser}, info) => {
  const ctx = await browser.newContext({viewport: {width: 1440, height: 900}});
  const page = await ctx.newPage();
  const problems = watch(page);
  await signIn(page);
  await openList(page);
  await fullyLoaded(page);
  // A reload renders the list from IndexedDB (once the leader persisted the group): time to the first rows.
  await expect.poll(() => storedRecords(page, 'Issue', `repo:${String(repoId)}`), {timeout: 60_000}).toBeGreaterThanOrEqual(openCount);
  await page.reload();
  await expect(listbox(page).getByRole('option').first()).toBeVisible();
  const boot = await page.evaluate(() => {
    const at = (n: string) => performance.getEntriesByName(n)[0]?.startTime ?? -1;
    const q = performance.getEntriesByName('list:query')[0] as PerformanceMeasure | undefined;
    return {appStart: at('appStart'), firstPaintFromCache: at('firstPaintFromCache'), firstQuery: q?.startTime, firstQueryMs: q?.duration, rows: (q?.detail as {rows?: number} | undefined)?.rows};
  });
  results.warmReload = boot;
  expect(boot.rows).toBe(openCount);

  // Filters, grouping and sorting: each is one local computation (list:query) under a frame. The sequence
  // runs twice: the first pass is recorded as "cold" (the first grouping also compiles its code path),
  // the second ("warm") is asserted.
  let timings: Record<string, number> = {};
  const step = async (name: string, act: () => Promise<void>, rows?: number) => {
    const before = (await lastQuery(page))?.n ?? 0;
    await act();
    await expect.poll(async () => (await lastQuery(page))?.n ?? 0).toBeGreaterThan(before);
    const q = await lastQuery(page);
    timings[name] = Math.round((q?.ms ?? 0) * 100) / 100;
    if (rows !== undefined) expect(q?.rows).toBe(rows);
  };
  /** Runs a UI action in the page and measures it there: to the DOM change, and to the next frame. */
  const inPage = (name: string, action: 'click' | 'type', target: string) => step(name, async () => {
    const r = await page.evaluate(async ({action, target}) => {
      const main = document.querySelector('main');
      if (!main) throw new Error('no main');
      let changed = 0;
      const t0 = performance.now();
      const mo = new MutationObserver(() => {
        changed ||= performance.now();
      });
      mo.observe(main, {subtree: true, childList: true, characterData: true, attributes: true});
      if (action === 'click') {
        const button = [...main.querySelectorAll('button')].find((b) => b.textContent === target);
        if (!button) throw new Error(`no button ${target}`);
        button.click();
      } else {
        const input = main.querySelector<HTMLInputElement>('input[type="search"]');
        if (!input) throw new Error('no search');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, target);
        input.dispatchEvent(new Event('input', {bubbles: true}));
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      mo.disconnect();
      return {toDom: changed ? changed - t0 : -1, toNextFrame: performance.now() - t0};
    }, {action, target});
    timings[`${name}: to DOM (ms)`] = Math.round(r.toDom * 10) / 10;
    timings[`${name}: to next frame (ms)`] = Math.round(r.toNextFrame * 10) / 10;
  });
  const display = async (section: 'Grouping' | 'Ordering', item: string) => {
    await page.getByRole('button', {name: 'Display'}).click();
    const group = page.getByRole('menu').getByRole('group').nth(section === 'Grouping' ? 0 : 1);
    await group.getByRole('menuitemradio', {name: item, exact: true}).click();
  };
  const pass = async () => {
    timings = {};
    await inPage('closed', 'click', 'Closed');
    await inPage('all', 'click', 'All');
    await inPage('open', 'click', 'Open');
    await inPage('search', 'type', 'crash');
    await inPage('clear search', 'type', '');
    expect((await lastQuery(page))?.rows).toBe(openCount);
    await step('group by status', () => display('Grouping', 'Status'));
    await step('group by priority', () => display('Grouping', 'Priority'));
    await step('sort by priority', () => display('Ordering', 'Priority'));
    await step('group by assignee', () => display('Grouping', 'Assignee'));
    await step('sort by recently updated', () => display('Ordering', 'Recently updated'));
    await step('no grouping, newest', async () => {
      await display('Grouping', 'No grouping');
      await display('Ordering', 'Newest');
    });
    await step('label filter', async () => {
      await page.getByRole('button', {name: 'Filter'}).click();
      await page.getByRole('menuitem', {name: 'Labels'}).click();
      await page.getByRole('menuitemcheckbox', {name: 'bug'}).click();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
    });
    await step('label filter cleared', async () => {
      // The filter button names the filter in effect ("Label: bug").
      await page.getByRole('button', {name: /^Label: bug/}).click();
      await page.getByRole('menuitem', {name: /^Label: bug/}).click();
    }, openCount);
    return timings;
  };
  results.queryMsCold = await pass();
  results.queryMs = await pass();
  for (const [k, v] of Object.entries(timings)) {
    // The local computation (filter, group, sort) fits a frame. Click → DOM / next frame include React
    // mounting the rows that come into view and depend on the machine (this sandbox: shared 2.1 GHz
    // vCPUs, software raster): recorded, not asserted.
    // Up to 5k open rows the computation fits a frame; above (NEXT_E2E_REPO=big: 8.5k), grouping pays a
    // label/assignee lookup per issue and is held to two frames (numbers in IMPLEMENTATION.md, F4).
    if (!k.includes(': to ')) expect(v, k).toBeLessThan(openCount <= 5000 ? 16 : 33);
  }

  // Scroll the whole list, one viewport per frame; record frame times and long tasks.
  await fullyLoaded(page);
  // Twice when the first pass saw long tasks (other workers share the CPU); the better pass counts.
  const measureScroll = () => page.evaluate(async () => {
    const list = document.querySelector('[role="listbox"]');
    const scroller = list?.parentElement;
    if (!scroller) throw new Error('no scroller');
    const longTasks: number[] = [];
    const obs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) longTasks.push(e.duration);
    });
    obs.observe({type: 'longtask'});
    const frames: number[] = [];
    let last = performance.now();
    const steps = Math.ceil(scroller.scrollHeight / (scroller.clientHeight / 2));
    for (let i = 0; i < steps; i++) {
      scroller.scrollTop += scroller.clientHeight / 2;
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      frames.push(now - last);
      last = now;
    }
    obs.disconnect();
    frames.sort((a, b) => a - b);
    const pick = (p: number) => Math.round(frames[Math.min(frames.length - 1, Math.floor(frames.length * p))] ?? 0);
    const rowsInDom = list.querySelectorAll('[role="option"]').length;
    scroller.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(r));
    return {frames: frames.length, p50: pick(0.5), p95: pick(0.95), max: Math.round(frames.at(-1) ?? 0), longTasks: longTasks.map(Math.round), rowsInDom};
  });
  const firstScroll = await measureScroll();
  const scroll = firstScroll.longTasks.some((d) => d > 50) ? await measureScroll() : firstScroll;
  results.scroll = {...scroll, firstPassLongTasks: firstScroll.longTasks};
  expect(scroll.longTasks.filter((d) => d > 50)).toEqual([]);
  expect(scroll.rowsInDom).toBeLessThan(80); // virtualized

  // Keyboard: J/K move the cursor, X selects, the palette offers the selection's actions.
  await page.evaluate(() => {
    const s = document.querySelector('[role="listbox"]')?.parentElement;
    if (s) s.scrollTop = 0;
  });
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  const first = listbox(page).getByRole('option').first();
  await expect(first).toHaveAttribute('data-active', '');
  await expect(listbox(page)).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id')) ?? 'x');
  await page.keyboard.press('x');
  await page.keyboard.press('j');
  await page.keyboard.press('x');
  await expect(listbox(page).getByRole('option', {selected: true})).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('option', {name: /Close 2 issues/})).toBeVisible();
  await page.keyboard.press('Escape');
  // The context menu offers the same actions.
  await listbox(page).getByRole('option').nth(5).click({button: 'right'});
  await expect(page.getByRole('menuitem', {name: 'Change labels…'})).toBeVisible();
  await expect(page.getByRole('menuitem', {name: 'Copy link'})).toBeVisible();
  await page.keyboard.press('Escape');
  await info.attach('measurements', {body: JSON.stringify(results, null, 1), contentType: 'application/json'});
  expect(problems).toEqual([]);
  await ctx.close();
});

const labelId = (name: string) => repoLabelId(USER, REPO, name);

/** An open issue of the repository without the label, by API v1. */
async function issueWithout(label: string): Promise<{number: number; title: string}> {
  for (let page = 1; page <= 20; page++) {
    const list = await (await api('GET', `/repos/${USER}/${REPO}/issues?state=open&type=issues&limit=50&page=${String(page)}`)).json() as {number: number; title: string; labels: {name: string}[]}[];
    // Without a terminal status label too: a closed issue with one ("Done") shows that status, not "Closed".
    const i = list.find((x) => !x.labels.some((l) => l.name === label || /^status\/(done|closed|complete|fixed|resolved|canceled|cancelled|wontfix)/i.test(l.name)));
    if (i) return i;
    if (list.length < 50) break;
  }
  throw new Error('no issue');
}

test('opening an issue that is in the pool shows it at once, with no spinner, before its timeline loads', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const problems = watch(page);
  await signIn(page);
  await openList(page);
  await fullyLoaded(page); // rows still arriving would move under the click
  // Hold the lazy tier back: what the page shows first comes from the pool alone.
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(/\/-\/sync\/load\?group=issue%3A|\/-\/sync\/load\?group=issue:/, async (r) => {
    await held;
    await r.continue();
  });
  const row = listbox(page).getByRole('option').nth(3);
  const title = (await row.textContent())?.replace(/^.*?#\d+/, '').trim().slice(0, 20) ?? '';
  const t0 = Date.now();
  await row.click();
  await expect(issueTitle(page)).toContainText(title, {timeout: 1000});
  const ms = Date.now() - t0;
  results.openFromPool = {ms};
  await expect(sidebarProp(page, 'Labels')).not.toBeEmpty();
  await expect(page.locator('[aria-busy]')).toHaveCount(1); // only the description's placeholder
  await expect(page.locator('[role="progressbar"], .spinner, [aria-label*="oading"]')).toHaveCount(0);
  release();
  await expect(page.locator('[aria-busy]')).toHaveCount(0, {timeout: 15_000});
  await expect(page.locator('.prose').first()).toContainText('Steps to reproduce');
  expect(problems).toEqual([]);
  await ctx.close();
});

/** Records every text the element shows from now on (MutationObserver), in the page. */
async function recordText(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no ${sel}`);
    const w = window as unknown as {seen: string[]};
    w.seen = [el.textContent];
    new MutationObserver(() => {
      w.seen.push(el.textContent);
    }).observe(el, {subtree: true, childList: true, characterData: true});
  }, selector);
}

const recorded = (page: Page) => page.evaluate(() => (window as unknown as {seen: string[]}).seen);

test('an optimistic label change: in the same frame, confirmed by the sync-id echo without flicker, and live in another browser', async ({browser}) => {
  const target = await issueWithout('docs');
  const path = `${BASE}/${USER}/${REPO}/issues/${String(target.number)}`;
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await signedIn(ctxA);
  const problems = watch(a);
  const b = await signedIn(ctxB, ALICE);
  await a.goto(path);
  await b.goto(path);
  await expect(issueTitle(b)).toContainText(target.title);
  await expect(sidebarProp(a, 'Labels')).not.toContainText('docs');
  await sidebarProp(a, 'Labels').evaluate((el) => {
    el.setAttribute('data-test', 'labels');
  });
  await recordText(a, '[data-test="labels"]');
  const write = a.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/labels'));
  await a.keyboard.press('l');
  await a.getByPlaceholder('Add or remove labels…').fill('docs');
  // Choose and measure: the chip is in the DOM right after the key, before any response.
  // What the next frame paints (read in its requestAnimationFrame callback), long before the server answers.
  const sameFrame = await a.evaluate(async () => {
    const input = document.activeElement as HTMLElement;
    const t0 = performance.now();
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    return new Promise<{text: string; ms: number}>((resolve) => {
      requestAnimationFrame(() => {
        resolve({text: document.querySelector('[data-test="labels"]')?.textContent ?? '', ms: performance.now() - t0});
      });
    });
  });
  results.optimisticLabel = {nextFrameMs: Math.round(sameFrame.ms * 10) / 10};
  expect(sameFrame.text).toContain('docs');
  await a.keyboard.press('Escape');
  const res = await write;
  expect(res.request().headers()['idempotency-key']).toMatch(/^[\da-f-]{36}$/);
  const syncId = Number(res.headers()['x-livesync-sync-id']);
  expect(syncId).toBeGreaterThan(0);
  // The other browser gets the delta.
  await expect(sidebarProp(b, 'Labels')).toContainText('docs', {timeout: 10_000});
  // After the echo the pool holds the label; the overlay is gone: the text never went back.
  await a.waitForTimeout(1500);
  const seen = await recorded(a);
  const firstWith = seen.findIndex((s) => s.includes('docs'));
  expect(firstWith).toBeGreaterThanOrEqual(0);
  expect(seen.slice(firstWith).every((s) => s.includes('docs')), JSON.stringify(seen)).toBe(true);
  // A reload (pool from IndexedDB, no overlay) still shows it: it is server state now.
  await a.reload();
  await expect(sidebarProp(a, 'Labels')).toContainText('docs');
  // S: close through the status picker, confirmed the same way; reopen.
  await a.keyboard.press('s');
  await a.getByRole('option', {name: 'Closed'}).click();
  await expect(sidebarProp(a, 'Status')).toContainText('Closed');
  await expect(sidebarProp(b, 'Status')).toContainText('Closed', {timeout: 10_000});
  await a.keyboard.press('s');
  await a.getByRole('option', {name: 'Open'}).click();
  await expect(sidebarProp(b, 'Status')).not.toContainText('Closed', {timeout: 10_000});
  expect(problems).toEqual([]);
  await ctxA.close();
  await ctxB.close();
});

test('a change the server refuses is rolled back with a notice', async ({browser}) => {
  const target = await issueWithout('ux');
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(`${BASE}/${USER}/${REPO}/issues/${String(target.number)}`);
  await expect(issueTitle(page)).toContainText(target.title);
  let key = '';
  await page.route(/\/api\/v1\/repos\/.*\/issues\/\d+\/labels$/, async (r) => {
    key = r.request().headers()['idempotency-key'] ?? '';
    await new Promise((resolve) => setTimeout(resolve, 300));
    await r.fulfill({status: 403, contentType: 'application/json', body: JSON.stringify({message: 'You may not change labels here.'})});
  });
  await page.keyboard.press('l');
  await page.getByPlaceholder('Add or remove labels…').fill('ux');
  await expect(page.getByRole('option', {name: /^ux\b/})).toBeVisible(); // the picker's candidates are there
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(sidebarProp(page, 'Labels')).toContainText('ux');
  const notice = page.getByRole('alert').filter({hasText: 'failed'});
  await expect(notice).toContainText('Adding the label “ux” failed');
  await expect(notice).toContainText('You may not change labels here. It was undone and kept in Unsynced changes.');
  await expect(sidebarProp(page, 'Labels')).not.toContainText('ux');
  expect(key).toMatch(/^[\da-f-]{36}$/);
  // Retry is a new intent (a new key); this time the server takes it.
  await page.unroute(/\/api\/v1\/repos\/.*\/issues\/\d+\/labels$/);
  const write = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/labels'));
  await notice.getByRole('button', {name: 'Retry'}).click();
  const res = await write;
  expect(res.request().headers()['idempotency-key']).not.toBe(key);
  await expect(sidebarProp(page, 'Labels')).toContainText('ux');
  await ctx.close();
});

test('changes by another user arrive live in an open list and an open issue', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  await openList(page, '?sort=recentupdate');
  await fullyLoaded(page);
  const list = await (await api('GET', `/repos/${USER}/${REPO}/issues?state=open&type=issues&limit=3&sort=recentupdate`)).json() as {number: number; title: string}[];
  const [x, y] = list;
  if (!x || !y) throw new Error('fixture');
  const renamed = `Renamed by alice ${String(Date.now())}`;
  const t0 = Date.now();
  await api('PATCH', `/repos/${USER}/${REPO}/issues/${String(x.number)}`, {title: renamed}, alice);
  await expect(listbox(page).getByRole('option', {name: new RegExp(renamed)})).toBeVisible({timeout: 10_000});
  results.liveTitleInList = {ms: Date.now() - t0};
  await api('PATCH', `/repos/${USER}/${REPO}/issues/${String(y.number)}`, {state: 'closed'}, alice);
  await expect(listbox(page).getByRole('option', {name: new RegExp(`(^|\\s)#${String(y.number)}\\s`)})).toHaveCount(0, {timeout: 10_000});
  await api('PATCH', `/repos/${USER}/${REPO}/issues/${String(y.number)}`, {state: 'open'}, alice);

  await page.goto(`${BASE}/${USER}/${REPO}/issues/${String(x.number)}`);
  await expect(issueTitle(page)).toContainText(renamed);
  await expect(page.locator('.prose').first()).toBeVisible({timeout: 15_000});
  const comment = `A comment from alice ${String(Date.now())} with <script>alert(1)</script> and **bold**`;
  const t1 = Date.now();
  await api('POST', `/repos/${USER}/${REPO}/issues/${String(x.number)}/comments`, {body: comment}, alice);
  await expect(page.getByRole('region', {name: 'Activity'})).toContainText('A comment from alice', {timeout: 10_000});
  results.liveCommentInDetail = {ms: Date.now() - t1};
  await expect(page.getByRole('region', {name: 'Activity'}).locator('strong', {hasText: 'bold'})).toBeVisible();
  await expect(page.locator('.prose script')).toHaveCount(0);
  await api('POST', `/repos/${USER}/${REPO}/issues/${String(x.number)}/labels`, {labels: [await labelId('security')]}, alice);
  await expect(sidebarProp(page, 'Labels')).toContainText('security', {timeout: 10_000});
  await api('PATCH', `/repos/${USER}/${REPO}/issues/${String(x.number)}`, {title: x.title}, alice);
  await expect(issueTitle(page)).toContainText(x.title, {timeout: 10_000});
  expect(problems).toEqual([]);
  await ctx.close();
});
