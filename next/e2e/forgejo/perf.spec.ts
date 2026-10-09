// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The performance targets of PLAN §2 / §5.8 / §8, measured in the browser
// against the real server, each over several runs with the median (or a
// high quantile) asserted against a documented threshold, so a slow
// sample on a shared machine does not fail the suite but a regression
// does. Every number is printed, attached, and appended to
// NEXT_E2E_PERF_OUT (tools/ci.sh's report; IMPLEMENTATION.md F8 has them).
//
//   target (PLAN)                                    measured as                                     asserted
//   boot-route JS ≤ 500 KiB br, CSS ≤ 30 KiB br       what Forgejo serves for /-/next/, brotli q11     ≤ budget
//   (tools/budget.ts BUDGET)
//   warm boot → interactive issue list < 300 ms      navigation start → the list's first row in the   median of 8 < 300 ms
//   (PLAN: p75; p75 is recorded)                     DOM (React committed it: handlers attached), no  (p75 recorded)
//                                                    bootstrap or load fetched
//   the same offline                                 the same, served by the service worker          median of 8 < 300 ms
//   a local mutation < 16 ms (≤ 1 frame)             the key (event.timeStamp) → the label in the    median of 10 < 16 ms, all
//                                                    DOM, the server's answer held 400 ms; and →     before the answer; p95
//                                                    the next frame (rAF)                            next frame < 33 ms
//   a commit reaches another client < 150 ms p95     another user's PATCH sent from the page →       p95 of 20 < 150 ms,
//                                                    the title in this page's DOM (an upper bound:  every one arrives
//                                                    it includes the request before the commit)
//   switching to a cached file < 100 ms              click → its highlighted lines painted, nothing  p50, p90 of 15 < 100 ms
//                                                    fetched
//   a 5k-line PR scrolls at 60 fps                   rAF intervals scrolling the whole diff 120 px    median run: p50 < 20,
//                                                    a frame, 3 runs                                 p95 < 34 ms, ≤ 3 % of
//                                                                                                    frames > 32 ms; 2 of 3
//                                                                                                    runs without a long task
//                                                                                                    ≥ 50 ms, nor a file-boundary
//                                                                                                    frame ≥ 50 ms
//
// The scroll bound is not PLAN's strict "no frame > 32 ms": this sandbox's
// software rasterizer on shared vCPUs drops 1–4 frames in 600 scrolling an
// empty page (F7). On real hardware set NEXT_E2E_STRICT_FPS=1.

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
// Not serial: one target missed does not keep the others from being measured (the fixtures are idempotent).

const RUN = Date.now().toString(36);
/** The list repository (lists.spec.ts seeds the same one; seeding is idempotent). */
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
  // Code: three files to switch between, and a 5 000-line pull request over ten files.
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

// ── Budgets ────────────────────────────────────────────────────────────────

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
  // What a cold boot actually downloads of those files (the server's compression for this browser), for the record.
  await page.goto(`${BASE}/-/next/`);
  await expect(page.getByRole('button', {name: 'Sign in'})).toBeVisible();
  const transferred = await page.evaluate((boot) => performance.getEntriesByType('resource')
    .filter((e) => boot.includes(new URL(e.name).pathname))
    .reduce((n, e) => n + (e as PerformanceResourceTiming).encodedBodySize, 0), Object.keys(files).map((f) => new URL(f, `${BASE}/`).pathname));
  record('budget: boot JS', [js / 1024], {cssKiBbr: css / 1024, transferredJsKiB: transferred / 1024, files: Object.keys(files).length}, 'KiB br');
  expect(js).toBeLessThanOrEqual(BUDGET.js);
  expect(css).toBeLessThanOrEqual(BUDGET.css);
});

// ── Warm boot ──────────────────────────────────────────────────────────────

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
    // Offline, the document comes from the service worker, and the app knows it is offline.
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
  // Warm: the repository is on this device (stored), and the service worker has this build.
  await expect.poll(() => storedGroup(page, `repo:${String(listRepoId)}`), {timeout: 60_000}).toBe(true);
  await swReady(page);
  await page.reload(); // the first boot served by a fresh worker fills the code cache (not a warm boot)
  await expect(issueList(page).getByRole('option').first()).toBeVisible();

  // From local data: no bootstrap or lazy load is fetched by these boots (the socket resumes from the
  // stored positions).
  const loads: string[] = [];
  page.on('request', (r) => {
    if (/\/-\/sync\/(bootstrap|load)\b/.test(r.url())) loads.push(r.url());
  });
  const online = await warmBoots(page, 8, false);
  expect(loads).toEqual([]);
  // The list really is interactive at that point: J puts the cursor on a row.
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

// ── Local mutation ─────────────────────────────────────────────────────────

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
  // The server's answer is held back 400 ms: what the DOM shows before that is the local apply alone.
  const HOLD = 400;
  await page.route(/\/api\/v1\/repos\/.*\/issues\/\d+\/labels/, async (r) => {
    await new Promise((resolve) => setTimeout(resolve, HOLD));
    await r.continue();
  });
  const dom: number[] = [];
  const frame: number[] = [];
  const eventTiming: number[] = [];
  // An even number of toggles: the issue ends as it was.
  for (let i = 0; i < 10; i++) {
    const had = (await labels.innerText()).includes('performance');
    await page.keyboard.press('l');
    await page.getByPlaceholder('Add or remove labels…').fill('performance');
    await expect(page.getByRole('option', {name: /^performance\b/})).toBeVisible();
    // In the page: the key's timestamp, when the label appears in (or leaves) the DOM, and the next frame.
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
    // Let it confirm before the next one (each measured on a quiet page, as a person would).
    await expect(page.getByRole('button', {name: /: show unsynced changes$/})).not.toContainText('pending', {timeout: 30_000});
  }
  await page.unroute(/\/api\/v1\/repos\/.*\/issues\/\d+\/labels/);
  record('local mutation: key → DOM (ms)', dom);
  record('local mutation: key → next frame (ms)', frame, {eventTimingDurations: eventTiming});
  expect(dom.every(Number.isFinite)).toBe(true);
  // Every one before the (held) answer: optimistic, not rendered on the 2xx.
  expect(Math.max(...dom)).toBeLessThan(HOLD);
  expect(median(dom)).toBeLessThan(16);
  expect(quantile(frame, 0.95)).toBeLessThan(33);
  expect(problems).toEqual([]);
  await ctx.close();
});

// ── Commit → another client ────────────────────────────────────────────────

test('a commit reaches another client in < 150 ms (p95)', async ({browser}) => {
  const [issue] = await apiJson<{number: number; title: string}[]>('GET', `/repos/${USER}/${LIST_REPO}/issues?state=open&type=issues&limit=1&sort=oldest`);
  if (!issue) throw new Error('fixture');
  const ctx = await browser.newContext();
  const page = await signedIn(ctx, ALICE);
  const problems = watch(page);
  await page.goto(`${BASE}/${USER}/${LIST_REPO}/issues/${String(issue.number)}`);
  const heading = page.getByRole('main').getByRole('heading', {level: 2});
  await expect(heading).toContainText(issue.title, {timeout: 30_000});
  await expect(page.getByRole('button', {name: /: show unsynced changes$/})).toContainText('Live', {timeout: 30_000});
  const sent: number[] = [];
  const answered: number[] = [];
  // dev renames the issue (API v1, from this page's clock); this page shows the new title when the delta lands.
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
    // The first is a warm-up (connections, caches).
    if (i === 0) continue;
    sent.push(r.sent);
    answered.push(r.answered);
  }
  await api('PATCH', `/repos/${USER}/${LIST_REPO}/issues/${String(issue.number)}`, {title: issue.title.replace(/ \[perf \d+\]$/, '')}, aliceAuth);
  record('commit → another client: write sent → shown (ms, upper bound)', sent, {afterAnswer: answered.map((x) => Math.round(x))});
  // Every commit arrives (a lost delta is a failure, not a slow sample), and fast.
  expect(sent.every(Number.isFinite)).toBe(true);
  expect(quantile(sent, 0.95)).toBeLessThan(150);
  expect(problems).toEqual([]);
  await ctx.close();
});

// ── Code ───────────────────────────────────────────────────────────────────

test('switching to a cached file paints in < 100 ms', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await page.goto(codeUrl(CODE_REPO, 'src/branch/main/src/main.go'));
  await expect(page.locator('.text-syn-keyword').first()).toBeVisible({timeout: 15_000});
  // Warm the cache: every file of the loop seen once (fetched, highlighted).
  for (const f of ['other.go', 'third.ts']) {
    await page.goto(codeUrl(CODE_REPO, `src/branch/main/src/${f}`));
    await expect(page.locator('.text-syn-keyword').first()).toBeVisible({timeout: 15_000});
  }
  // Cached: the measured switches (the click on the file, not the way back to its directory) fetch nothing:
  // the file's blob and highlight come from this device.
  const fetched: string[] = [];
  let measuring = false;
  page.on('request', (r) => {
    if (measuring && /\/(api\/v1|-\/sync\/api)\//.test(r.url())) fetched.push(r.url());
  });
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    for (const to of ['third.ts', 'main.go', 'other.go'] as const) {
      // From the directory, click the file; measure in the page: click → the file's lines painted (next frame).
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
  // < 100 ms (PLAN Phase 4 exit); the single slowest sample is recorded, not asserted (shared vCPUs: GC, other load).
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
      // Frames in which the file in view changed (the file list's cursor follows it): the costliest.
      const boundary: number[] = [];
      const inView = () => document.querySelector('[role=listbox][aria-label="Changed files"] [aria-selected=true]')?.textContent ?? '';
      let file = inView();
      await new Promise((r) => requestAnimationFrame(r));
      let last = performance.now();
      const step = 120; // px per frame (≈ 7 200 px/s)
      // The whole diff (its height read every frame; a scroll that stops moving ends the run).
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
    expect(r.rows).toBeLessThan(200); // virtualized
    expect(r.boundaries).toBeGreaterThanOrEqual(5);
  }
  // A frame is 16.7 ms; headless Chromium's frame clock here reads 16.7–18 for a smooth page (a 30 fps
  // page reads 33): the median run's median frame under 20 ms.
  expect(median(runs.map((r) => r.p50))).toBeLessThan(20);
  expect(mid.p95).toBeLessThan(34);
  expect(median(runs.map((r) => r.over32 / r.frames))).toBeLessThanOrEqual(STRICT_FPS ? 0 : 0.03);
  expect(median(runs.map((r) => r.longest))).toBeLessThan(50);
  expect(median(runs.map((r) => r.boundaryMax))).toBeLessThan(50);
  await ctx.close();
});
