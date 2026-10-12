// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Assert repeated-run medians/quantiles to tolerate shared-machine outliers; attach and report timings.
// Software rasterization can drop frames even on an empty page; NEXT_E2E_STRICT_FPS=1 uses strict bounds.

import {brotliCompressSync, constants} from 'node:zlib';
import {expect, type Page, test} from '@playwright/test';
import {api, apiJson, b64, seed} from '../lib/api.ts';
import {indicator, issueList, signedIn, watch} from '../lib/app.ts';
import {changeFiles, codeUrl, goFile, type Pull, tsFile} from '../lib/code.ts';
import {storedGroup, swReady} from '../lib/device.ts';
import {ALICE, aliceAuth, BASE, USER} from '../lib/env.ts';
import {median, quantile, record} from '../lib/perf.ts';
import {BUDGET} from '../../tools/budget.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
// Keep targets independent so one failure cannot suppress the other measurements.

const RUN = Date.now().toString(36);
const LIST_REPO = process.env.NEXT_E2E_REPO ?? 'f4';
const LIST_ISSUES = Number(process.env.NEXT_E2E_ISSUES ?? 400);
const CODE_REPO = `perf-${RUN}`;
const BIG = 5000;
const STRICT_FPS = process.env.NEXT_E2E_STRICT_FPS === '1';

let listRepoId = 0;
let bigPull: Pull;
/** A token of dev for writes made from a page (basic auth would add the password hash to every request). */
let devToken = '';

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  seed(LIST_REPO, LIST_ISSUES);
  listRepoId = (await apiJson<{id: number}>('GET', `/repos/${USER}/${LIST_REPO}`)).id;
  devToken = (await apiJson<{sha1: string}>('POST', `/users/${USER}/tokens`, {name: `perf-${RUN}`, scopes: ['write:issue', 'read:repository']})).sha1;
  await apiJson('POST', '/user/repos', {name: CODE_REPO, auto_init: true, default_branch: 'main'});
  await changeFiles(CODE_REPO, {branch: 'main', message: 'Add sources', files: [
    {operation: 'create', path: 'src/main.go', content: b64(goFile(80))},
    {operation: 'create', path: 'src/other.go', content: b64(goFile(40))},
    {operation: 'create', path: 'src/third.ts', content: b64(tsFile(200))},
  ]});
  await changeFiles(CODE_REPO, {branch: 'main', new_branch: 'big', message: 'Big change', files: Array.from({length: 10}, (_, i) => ({
    operation: 'create', path: `src/big/part${String(i)}.ts`, content: b64(tsFile(BIG / 10)),
  }))});
  bigPull = await apiJson<Pull>('POST', `/repos/${USER}/${CODE_REPO}/pulls`, {head: 'big', base: 'main', title: 'A big change'});
});

test.afterAll(async () => {
  await api('DELETE', `/repos/${USER}/${CODE_REPO}`);
  await api('DELETE', `/users/${USER}/tokens/perf-${RUN}`);
});


test('the boot route Forgejo serves stays within the JS and CSS budgets', async ({page}) => {
  const html = await (await fetch(`${BASE}/-/next/`)).text();
  const br = (b: Buffer | string) => brotliCompressSync(b, {params: {[constants.BROTLI_PARAM_QUALITY]: 11}}).length;
  const attrs = (tag: string): Record<string, string | undefined> => Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map((m) => [m[1] ?? '', m[2] ?? '']));
  let js = 0;
  let css = 0;
  const files: Record<string, number> = {};
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const a = attrs(`<script ${m[1] ?? ''}`);
    if (a.type === 'application/json') continue; // the config block is data
    const src = a.src;
    if (src) {
      const size = br(Buffer.from(await (await fetch(new URL(src, `${BASE}/`))).arrayBuffer()));
      files[src] = size;
      js += size;
    } else js += br(m[2] ?? '');
  }
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.rel !== 'modulepreload' && a.rel !== 'stylesheet') continue;
    const href = a.href ?? '';
    const size = br(Buffer.from(await (await fetch(new URL(href, `${BASE}/`))).arrayBuffer()));
    files[href] = size;
    if (a.rel === 'modulepreload') js += size;
    else css += size;
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) css += br(m[1] ?? '');
  await page.goto(`${BASE}/-/next/`);
  await expect(page.getByRole('button', {name: 'Sign in'})).toBeVisible();
  const transferred = await page.evaluate((boot) => performance.getEntriesByType('resource')
    .filter((e) => boot.includes(new URL(e.name).pathname))
    .reduce((n, e) => n + (e as PerformanceResourceTiming).encodedBodySize, 0), Object.keys(files).map((f) => new URL(f, `${BASE}/`).pathname));
  record('budget: boot JS', [js / 1024], {cssKiBbr: css / 1024, transferredJsKiB: transferred / 1024, files: Object.keys(files).length}, 'KiB br');
  expect(js).toBeLessThanOrEqual(BUDGET.js);
  expect(css).toBeLessThanOrEqual(BUDGET.css);
});


/** Records when the issue list's first row is in the DOM (ms from navigation start) in every load of the page. */
async function watchList(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {__listAt?: number};
    const mo = new MutationObserver(() => {
      if (document.querySelector('[role=listbox][aria-label="Issues"] [role=option]')) {
        w.__listAt = performance.now();
        mo.disconnect();
      }
    });
    mo.observe(document, {subtree: true, childList: true});
  });
}

const listAt = (page: Page) => page.evaluate(() => (window as unknown as {__listAt?: number}).__listAt ?? Number.NaN);

async function warmBoots(page: Page, runs: number, offline: boolean): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const res = await page.reload();
    if (offline) expect(res?.fromServiceWorker()).toBe(true);
    await expect(issueList(page).getByRole('option').first()).toBeVisible();
    if (offline) await expect(indicator(page)).toContainText('Offline');
    times.push(await listAt(page));
  }
  expect(times.every(Number.isFinite)).toBe(true);
  return times;
}

test('a warm boot reaches an interactive issue list in < 300 ms, online and offline', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  await watchList(page);
  await page.goto(`${BASE}/${USER}/${LIST_REPO}/issues`);
  await expect(issueList(page).getByRole('option').first()).toBeVisible({timeout: 60_000});
  await expect.poll(() => storedGroup(page, `repo:${String(listRepoId)}`), {timeout: 60_000}).toBe(true);
  await swReady(page);
  await page.reload(); // A fresh worker's first boot fills the code cache; exclude it from warm measurements.
  await expect(issueList(page).getByRole('option').first()).toBeVisible();

  const loads: string[] = [];
  page.on('request', (r) => {
    if (/\/-\/sync\/(bootstrap|load)\b/.test(r.url())) loads.push(r.url());
  });
  const online = await warmBoots(page, 8, false);
  expect(loads).toEqual([]);
  await issueList(page).focus();
  await page.keyboard.press('j');
  await expect(issueList(page).locator('[data-active]')).toHaveCount(1);
  const fp = await page.evaluate(() => performance.getEntriesByName('firstPaintFromCache')[0]?.startTime ?? Number.NaN);
  record('warm boot online: navigation → interactive issue list (ms)', online, {rows: LIST_ISSUES, p75: quantile(online, 0.75), firstPaintFromCacheLast: Math.round(fp)});

  await ctx.setOffline(true);
  const offline = await warmBoots(page, 8, true);
  record('warm boot offline: navigation → interactive issue list (ms)', offline, {p75: quantile(offline, 0.75)});
  await ctx.setOffline(false);
  expect(median(online)).toBeLessThan(300);
  expect(median(offline)).toBeLessThan(300);
  expect(problems.filter((p) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|net::/.test(p))).toEqual([]);
  await ctx.close();
});


test('a local mutation is in the DOM within a frame of the key, before the server answers', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  const [issue] = await apiJson<{number: number; title: string}[]>('GET', `/repos/${USER}/${LIST_REPO}/issues?state=open&type=issues&limit=1`);
  if (!issue) throw new Error('fixture');
  await page.goto(`${BASE}/${USER}/${LIST_REPO}/issues/${String(issue.number)}`);
  await expect(page.getByRole('main').getByRole('heading', {level: 2})).toContainText(issue.title, {timeout: 30_000});
  const labels = page.getByRole('complementary', {name: 'Properties'}).locator('dt').filter({hasText: /^Labels$/}).locator('xpath=following-sibling::dd[1]');
  await labels.evaluate((el) => {
    el.setAttribute('data-perf', 'labels');
  });
  // Delay the server answer so measurements isolate optimistic local application.
  const HOLD = 400;
  await page.route(/\/api\/v1\/repos\/.*\/issues\/\d+\/labels/, async (r) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD));
    await r.continue();
  });
  const dom: number[] = [];
  const frame: number[] = [];
  const eventTiming: number[] = [];
  for (let i = 0; i < 10; i++) {
    const had = (await labels.innerText()).includes('performance');
    await page.keyboard.press('l');
    await page.getByPlaceholder('Add or remove labels…').fill('performance');
    await expect(page.getByRole('option', {name: /^performance\b/})).toBeVisible();
    await page.evaluate((want) => {
      const w = window as unknown as {__m?: {key?: number; dom?: number; frame?: number; et?: number}};
      const m: {key?: number; dom?: number; frame?: number; et?: number} = {};
      w.__m = m;
      const el = document.querySelector('[data-perf=labels]');
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') m.key = e.timeStamp;
      }, {capture: true, once: true});
      const mo = new MutationObserver(() => {
        if ((el?.textContent.includes('performance') ?? false) === want && m.dom === undefined) {
          m.dom = performance.now();
          mo.disconnect();
          requestAnimationFrame(() => {
            m.frame = performance.now();
          });
        }
      });
      if (el) mo.observe(el, {subtree: true, childList: true, characterData: true});
      new PerformanceObserver((l, po) => {
        for (const e of l.getEntries()) {
          if (e.name === 'keydown' && m.key !== undefined && Math.abs(e.startTime - m.key) < 1) {
            m.et = e.duration;
            po.disconnect();
          }
        }
      }).observe({type: 'event', durationThreshold: 16} as PerformanceObserverInit);
    }, !had);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as unknown as {__m: {frame?: number}}).__m.frame)).toBeDefined();
    const m = await page.evaluate(() => (window as unknown as {__m: {key: number; dom: number; frame: number; et?: number}}).__m);
    dom.push(m.dom - m.key);
    frame.push(m.frame - m.key);
    if (m.et !== undefined) eventTiming.push(m.et);
    await page.keyboard.press('Escape');
    // Confirm each mutation before the next to measure on a quiet page.
    await expect(indicator(page)).not.toContainText('pending', {timeout: 30_000});
  }
  await page.unroute(/\/api\/v1\/repos\/.*\/issues\/\d+\/labels/);
  record('local mutation: key → DOM (ms)', dom);
  record('local mutation: key → next frame (ms)', frame, {eventTimingDurations: eventTiming});
  expect(dom.every(Number.isFinite)).toBe(true);
  expect(Math.max(...dom)).toBeLessThan(HOLD);
  expect(median(dom)).toBeLessThan(16);
  expect(quantile(frame, 0.95)).toBeLessThan(33);
  expect(problems).toEqual([]);
  await ctx.close();
});


test('a commit reaches another client in < 150 ms (p95)', async ({browser}) => {
  const [issue] = await apiJson<{number: number; title: string}[]>('GET', `/repos/${USER}/${LIST_REPO}/issues?state=open&type=issues&limit=1&sort=oldest`);
  if (!issue) throw new Error('fixture');
  const ctx = await browser.newContext();
  const page = await signedIn(ctx, ALICE);
  const problems = watch(page);
  await page.goto(`${BASE}/${USER}/${LIST_REPO}/issues/${String(issue.number)}`);
  const heading = page.getByRole('main').getByRole('heading', {level: 2});
  await expect(heading).toContainText(issue.title, {timeout: 30_000});
  await expect(indicator(page)).toContainText('Live', {timeout: 30_000});
  const sent: number[] = [];
  const answered: number[] = [];
  for (let i = 0; i < 21; i++) {
    const title = `${issue.title.replace(/ \[perf \d+\]$/, '')} [perf ${String(i)}]`;
    const r = await page.evaluate(async ({url, token, title}) => {
      const h = document.querySelector('main h2');
      let seen = 0;
      const arrived = new Promise<void>((resolve) => {
        const mo = new MutationObserver(() => {
          if (h?.textContent.includes(title)) {
            seen = performance.now();
            mo.disconnect();
            resolve();
          }
        });
        if (h) mo.observe(h, {subtree: true, childList: true, characterData: true});
      });
      const t0 = performance.now();
      const res = await fetch(url, {method: 'PATCH', credentials: 'omit', headers: {'Authorization': `token ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({title})});
      const t1 = performance.now();
      if (!res.ok) throw new Error(`PATCH ${String(res.status)}`);
      await Promise.race([arrived, new Promise((resolve) => setTimeout(resolve, 5000))]);
      return {sent: seen ? seen - t0 : Number.POSITIVE_INFINITY, answered: seen ? seen - t1 : Number.POSITIVE_INFINITY};
    }, {url: `/api/v1/repos/${USER}/${LIST_REPO}/issues/${String(issue.number)}`, token: devToken, title});
    // Exclude the connection/cache warm-up sample.
    if (i === 0) continue;
    sent.push(r.sent);
    answered.push(r.answered);
  }
  await api('PATCH', `/repos/${USER}/${LIST_REPO}/issues/${String(issue.number)}`, {title: issue.title.replace(/ \[perf \d+\]$/, '')}, aliceAuth);
  record('commit → another client: write sent → shown (ms, upper bound)', sent, {afterAnswer: answered.map((x) => Math.round(x))});
  expect(sent.every(Number.isFinite)).toBe(true);
  expect(quantile(sent, 0.95)).toBeLessThan(150);
  expect(problems).toEqual([]);
  await ctx.close();
});


test('switching to a cached file paints in < 100 ms', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(codeUrl(CODE_REPO, 'src/branch/main/src/main.go'));
  await expect(page.locator('.text-syn-keyword').first()).toBeVisible({timeout: 15_000});
  for (const f of ['other.go', 'third.ts']) {
    await page.goto(codeUrl(CODE_REPO, `src/branch/main/src/${f}`));
    await expect(page.locator('.text-syn-keyword').first()).toBeVisible({timeout: 15_000});
  }
  const fetched: string[] = [];
  let measuring = false;
  page.on('request', (r) => {
    if (measuring && /\/(api\/v1|-\/sync\/api)\//.test(r.url())) fetched.push(r.url());
  });
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    for (const to of ['third.ts', 'main.go', 'other.go'] as const) {
      await page.getByRole('link', {name: 'src', exact: true}).first().click();
      await expect(page.getByRole('listbox', {name: 'Files'})).toBeVisible();
      measuring = true;
      samples.push(await page.evaluate(async (name) => {
        const row = [...document.querySelectorAll('[role=option]')].find((el) => el.textContent.startsWith(name)) as HTMLElement | undefined;
        if (!row) throw new Error(`no row ${name}`);
        const t0 = performance.now();
        row.click();
        const want = new RegExp(`src/${name.replace('.', '\\.')}, \\d+ lines`);
        for (;;) {
          await new Promise((r) => requestAnimationFrame(r));
          const list = [...document.querySelectorAll('[role=list]')].find((el) => want.test(el.getAttribute('aria-label') ?? ''));
          if (list?.querySelector('.text-syn-keyword')) return performance.now() - t0;
          if (performance.now() - t0 > 5000) return Number.POSITIVE_INFINITY;
        }
      }, to));
      measuring = false;
    }
  }
  record('cached file switch: click → highlighted lines painted (ms)', samples);
  expect(fetched).toEqual([]);
  expect(samples.every(Number.isFinite)).toBe(true);
  // Record, but do not assert, the slowest sample: shared CPUs add GC and scheduling outliers.
  expect(quantile(samples, 0.5)).toBeLessThan(100);
  expect(quantile(samples, 0.9)).toBeLessThan(100);
  await ctx.close();
});

interface ScrollRun {
  frames: number;
  p50: number;
  p95: number;
  over32: number;
  longest: number;
  boundaryMax: number;
  boundaries: number;
  rows: number;
}

test(`a ${String(BIG)}-line pull request diff scrolls at 60 fps`, async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(`${BASE}/${USER}/${CODE_REPO}/pulls/${String(bigPull.number)}?tab=files`);
  await expect(page.getByRole('list', {name: 'Changes'})).toBeVisible({timeout: 30_000});
  await expect(page.locator('.text-syn-keyword').first()).toBeVisible({timeout: 30_000});
  const runs: ScrollRun[] = [];
  for (let run = 0; run < 3; run++) {
    runs.push(await page.evaluate(async () => {
      const list = document.querySelector('[role=list][aria-label=Changes]');
      let scroller = list?.parentElement ?? null;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight && getComputedStyle(scroller).overflowY !== 'visible')) scroller = scroller.parentElement;
      if (!scroller) throw new Error('no scroller');
      scroller.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 300));
      const longTasks: number[] = [];
      const po = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) longTasks.push(e.duration);
      });
      po.observe({type: 'longtask', buffered: false});
      const frames: number[] = [];
      // File-boundary frames are the costliest because the file list's cursor also changes.
      const boundary: number[] = [];
      const inView = () => document.querySelector('[role=listbox][aria-label="Changed files"] [aria-selected=true]')?.textContent ?? '';
      let file = inView();
      await new Promise((r) => requestAnimationFrame(r));
      let last = performance.now();
      const step = 120;
      while (scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 1) {
        const before = scroller.scrollTop;
        scroller.scrollTop += step;
        if (scroller.scrollTop === before) break;
        await new Promise((res) => requestAnimationFrame(res));
        const now = performance.now();
        frames.push(now - last);
        const f = inView();
        if (f !== file) boundary.push(now - last);
        file = f;
        last = now;
      }
      po.disconnect();
      const sorted = [...frames].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      return {
        frames: frames.length, p50: q(0.5), p95: q(0.95), over32: frames.filter((f) => f > 32).length, longest: Math.max(0, ...longTasks),
        boundaryMax: Math.max(0, ...boundary), boundaries: boundary.length,
        rows: document.querySelectorAll('[role=list][aria-label=Changes] > [role=listitem]').length,
      };
    }));
  }
  const byP95 = [...runs].sort((a, b) => a.p95 - b.p95);
  const mid = byP95[1] ?? runs[0];
  if (!mid) throw new Error('no runs');
  record('5k-line diff scroll: frame interval p50 per run (ms)', runs.map((r) => r.p50), {runs});
  for (const r of runs) {
    expect(r.frames).toBeGreaterThan(200);
    expect(r.rows).toBeLessThan(200);
    expect(r.boundaries).toBeGreaterThanOrEqual(5);
  }
  // Headless Chromium's smooth frame clock spans 16.7–18 ms; allow a median below 20 ms.
  expect(median(runs.map((r) => r.p50))).toBeLessThan(20);
  expect(mid.p95).toBeLessThan(34);
  expect(median(runs.map((r) => r.over32 / r.frames))).toBeLessThanOrEqual(STRICT_FPS ? 0 : 0.03);
  expect(median(runs.map((r) => r.longest))).toBeLessThan(50);
  expect(median(runs.map((r) => r.boundaryMax))).toBeLessThan(50);
  await ctx.close();
});


test('loaded list search and diff scrolling avoid long tasks at 4x CPU', async ({browser}) => {
  const ctx = await browser.newContext();
  try {
    const page = await signedIn(ctx);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});
    const measure = async (interact: () => Promise<void>) => {
      const probe = await page.evaluateHandle(() => {
        const durations: number[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) durations.push(entry.duration);
        });
        observer.observe({type: 'longtask', buffered: false});
        return {durations, observer};
      });
      await interact();
      // Flush deferred rendering and final observer entries before reading the measurements.
      await page.waitForTimeout(500);
      const durations = await probe.evaluate(({durations, observer}) => {
        for (const entry of observer.takeRecords()) durations.push(entry.duration);
        observer.disconnect();
        return durations;
      });
      await probe.dispose();
      return durations;
    };
    await page.goto(`${BASE}/${USER}/${LIST_REPO}/issues`);
    await expect(issueList(page).getByRole('option').first()).toBeVisible();
    // Let navigation settle so its work is excluded from the interaction measurement.
    await page.waitForTimeout(1000);
    const search = page.getByRole('searchbox', {name: 'Search titles'});
    const typing: number[][] = [];
    for (let run = 0; run < 3; run++) {
      typing.push(await measure(async () => {
        await search.pressSequentially('crash', {delay: 80});
        await search.fill('');
      }));
    }
    await page.goto(`${BASE}/${USER}/${CODE_REPO}/pulls/${String(bigPull.number)}?tab=files`);
    await expect(page.getByRole('list', {name: 'Changes'})).toBeVisible();
    await expect(page.locator('.text-syn-keyword').first()).toBeVisible();
    await page.waitForTimeout(1000);
    const scrolling: number[][] = [];
    await page.getByRole('list', {name: 'Changes'}).hover();
    for (let run = 0; run < 3; run++) {
      scrolling.push(await measure(async () => {
        for (const direction of [1, -1]) for (let step = 0; step < 10; step++) {
          await page.mouse.wheel(0, direction * 500);
          await page.waitForTimeout(80);
        }
      }));
    }
    for (const [metric, runs] of [['4x list search', typing], ['4x diff wheel scroll', scrolling]] as const) {
      const maxima = runs.map((durations) => Math.max(0, ...durations));
      record(`${metric}: longest task per run`, maxima, {runs});
      expect(median(maxima)).toBeLessThan(50);
    }
  } finally {
    await ctx.close();
  }
});
