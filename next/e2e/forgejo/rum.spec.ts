// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// RUM (PLAN §5.8) end to end: a session's boot marks, a mutation's
// localApplied → acked → confirmed, the worst interaction (INP) and the
// queue's outcomes reach POST /-/sync/rum as B8's contract wants them —
// anonymous JSON with known names and numbers only, nothing that
// identifies the user or what they did — and the server counts them
// (/metrics, enabled by tools/dev-forgejo.sh e2e). And the
// `localStorage.profile = 1` switch loads React's profiling build.

import {expect, type Request, test} from '@playwright/test';
import {apiJson, seed} from '../lib/api.ts';
import {issueTitle, sidebarProp, signedIn, toggleLabel, watch} from '../lib/app.ts';
import {BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

const REPO = process.env.NEXT_E2E_REPO ?? 'f4';
const MARKS = new Set(['firstPaintFromCache', 'dataOpen', 'wsOpen', 'caughtUp', 'hydrateRoute', 'hydrateAll', 'mutationLocal', 'mutationAcked', 'mutationConfirmed', 'inp']);
const EVENTS = new Set(['intentFlushed', 'intentRetried', 'intentFailed', 'conflictMerged', 'conflictOverride', 'conflictDiscarded']);

test.beforeAll(() => {
  test.setTimeout(10 * 60_000);
  seed(REPO, Number(process.env.NEXT_E2E_ISSUES ?? 400));
});

/** Sum of a Prometheus counter/histogram-count series of /metrics (labels matched as a substring). */
async function metric(name: string, label: string): Promise<number> {
  const text = await (await fetch(`${BASE}/metrics`)).text();
  return text.split('\n').filter((l) => l.startsWith(name) && l.includes(label)).reduce((n, l) => n + Number(l.split(' ').at(-1)), 0);
}

test('marks, mutation timings, INP and queue outcomes are posted to /-/sync/rum, anonymously, and counted by the server', async ({browser}) => {
  const before = {
    acked: await metric('forgejo_livesync_rum_seconds_count', 'mark="mutationAcked"'),
    paint: await metric('forgejo_livesync_rum_seconds_count', 'mark="firstPaintFromCache"'),
    flushed: await metric('forgejo_livesync_rum_events_total', 'event="intentFlushed"'),
    rejected: await metric('forgejo_livesync_rum_rejected_total', ''),
  };
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  // (Playwright reports these 204 POSTs as aborted; the page gets its 204, and /metrics below shows the
  // server took them.)
  const reports: Request[] = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/-/sync/rum')) reports.push(req);
  });
  const [issue] = await apiJson<{number: number; title: string}[]>('GET', `/repos/${USER}/${REPO}/issues?state=open&type=issues&limit=1`);
  if (!issue) throw new Error('fixture');
  await page.goto(`${BASE}/${USER}/${REPO}/issues/${String(issue.number)}`);
  await expect(issueTitle(page)).toContainText(issue.title, {timeout: 30_000});
  // A mutation, confirmed by the server.
  const had = (await sidebarProp(page, 'Labels').innerText()).includes('tests');
  await toggleLabel(page, 'tests');
  await expect(page.getByRole('button', {name: /: show unsynced changes$/})).not.toContainText('pending', {timeout: 30_000});
  // The page is hidden (tab switched / closed): the reporter sends what it has, INP included.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => reports.length, {timeout: 15_000}).toBeGreaterThan(0);
  await page.waitForTimeout(1000);

  const marks = new Set<string>();
  const events = new Set<string>();
  for (const req of reports) {
    expect(req.method()).toBe('POST');
    const headers = await req.allHeaders();
    expect(headers['content-type']).toBe('application/json');
    // Anonymous: no token, no cookie.
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    const raw = req.postData() ?? '';
    expect(raw.length).toBeLessThan(8 << 10);
    // Nothing of the user or of what they did: no names, titles, ids or URLs.
    for (const leak of [USER, issue.title, REPO, 'http', '/']) expect(raw).not.toContain(leak);
    const body = JSON.parse(raw) as {marks?: Record<string, unknown>; events?: Record<string, unknown>};
    expect(Object.keys(body).every((k) => k === 'marks' || k === 'events')).toBe(true);
    for (const [k, v] of Object.entries(body.marks ?? {})) {
      expect(MARKS.has(k), k).toBe(true);
      expect(typeof v).toBe('number');
      expect(v as number).toBeGreaterThanOrEqual(0);
      marks.add(k);
    }
    for (const [k, v] of Object.entries(body.events ?? {})) {
      expect(EVENTS.has(k), k).toBe(true);
      expect(Number.isInteger(v)).toBe(true);
      events.add(k);
    }
  }
  console.log(`RUM reports: ${String(reports.length)}; marks ${[...marks].join(' ')}; events ${[...events].join(' ')}; toggled ${had ? 'off' : 'on'}`);
  for (const m of ['firstPaintFromCache', 'dataOpen', 'wsOpen', 'caughtUp', 'hydrateRoute', 'hydrateAll', 'mutationLocal', 'mutationAcked', 'mutationConfirmed', 'inp']) expect(marks.has(m), m).toBe(true);
  expect(events.has('intentFlushed')).toBe(true);
  // The server took them (its histograms and counters moved; nothing was rejected).
  expect(await metric('forgejo_livesync_rum_seconds_count', 'mark="mutationAcked"')).toBeGreaterThan(before.acked);
  expect(await metric('forgejo_livesync_rum_seconds_count', 'mark="firstPaintFromCache"')).toBeGreaterThan(before.paint);
  expect(await metric('forgejo_livesync_rum_events_total', 'event="intentFlushed"')).toBeGreaterThan(before.flushed);
  expect(await metric('forgejo_livesync_rum_rejected_total', '')).toBe(before.rejected);
  expect(problems).toEqual([]);
  await ctx.close();
});

test('localStorage.profile = 1 renders with React\'s profiling build; without it, the page never loads that build', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  const fetched: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/-/next/assets/')) fetched.push(r.url());
  });
  await page.goto(`${BASE}/${USER}/${REPO}/issues`);
  await expect(page.getByRole('listbox', {name: 'Issues'}).getByRole('option').first()).toBeVisible({timeout: 30_000});
  expect(fetched.some((u) => u.includes('react-dom-profiling'))).toBe(false);
  expect(await page.evaluate(() => performance.getEntriesByName('react:commit').length)).toBe(0);

  await page.evaluate(() => {
    localStorage.setItem('profile', '1');
  });
  await page.reload();
  await expect(page.getByRole('listbox', {name: 'Issues'}).getByRole('option').first()).toBeVisible();
  expect(fetched.some((u) => u.includes('react-dom-profiling'))).toBe(true);
  // Every commit is a `react:commit` measure (Profiler onRender).
  await expect.poll(() => page.evaluate(() => performance.getEntriesByName('react:commit').length)).toBeGreaterThan(0);
  const detail = await page.evaluate(() => (performance.getEntriesByName('react:commit')[0] as PerformanceMeasure).detail as {id: string; phase: string});
  expect(detail.id).toBe('app');
  await page.evaluate(() => {
    localStorage.removeItem('profile');
  });
  expect(problems).toEqual([]);
  await ctx.close();
});
