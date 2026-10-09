// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The link crawler (QA 2026-10-09, a permanent gate; tools/ci.sh runs it as
// its own step on PostgreSQL and MySQL): signed in as dev on a seeded server,
// it walks the app the way a user does — by CLICKING links in the shell, the
// sidebar, page headers and their menus, lists, detail and code views, a
// board's cards, and the ⌘K palette's navigation commands — breadth first
// from Home, to a bounded depth, one visit per route pattern
// (/:owner/:repo/issues/:n, code/:owner/:repo/src/branch/…/file, …).
//
// It fails on:
//   * a page reached from an in-app link that says "Not available here",
//     "Not found", "Could not load" (any of NOT_HERE), or that is not the app
//     any more (a document navigation to a classic page by an unmarked link);
//   * a same-origin link that leaves the app without saying so: classic exits
//     are marked (data-classic: ClassicLink, menu items with `classic`), new
//     tabs (target=_blank) and downloads are left alone;
//   * an uncaught exception or a console error on any page;
//   * a same-origin HTTP answer ≥ 400 (EXPECTED_HTTP lists the documented ones).
//
// Then it types the addresses no link produces: list searches whose values read
// as numbers or booleans, pasted code addresses (/{owner}/{repo}/src/branch/…),
// and the classic UI's "Back to Forgejo Next" pill on classic pages (each must
// land on a page of the app, not a dead end; a repository's page in that
// repository, not on Home).
//
// QA round 2 (2026-10-09) added what slipped past it: a click must arrive
// where its link points (a pull request page once sent every navigation away
// from it back to itself), every issue and pull request page is left by the
// sidebar's Home and come back to with Back, and every classic exit's
// address is requested once: the classic UI must have that page (no 404).
//
// The coverage (links seen, clicked, skipped; the route patterns visited and
// how) is printed and attached (crawl-coverage.json).

import {expect, type Locator, type Page, test} from '@playwright/test';
import {isSpaRoute} from '../../src/sw/routes.ts';
import {api, apiJson, b64, ensureUser, ok} from '../lib/api.ts';
import {signedIn, watch} from '../lib/app.ts';
import {changeFiles, goFile} from '../lib/code.ts';
import {aliceAuth as alice, ALICE, BASE, USER} from '../lib/env.ts';
import {classicProject} from '../lib/projects.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');

const RUN = Date.now().toString(36);
const REPO = `crawl-${RUN}`;
const ORG = `crawl-org-${RUN}`;

/** Clicks from Home at most (Home is depth 0). */
const MAX_DEPTH = 4;
/** Visits at most (a guard: one per route pattern keeps it far below). */
const MAX_VISITS = 160;
/** Fewer patterns than this means the crawler itself is broken (a selector, the seed). */
const MIN_PATTERNS = 30;

/** What a page that is a dead end says (EmptyState titles, the not-found page). */
const NOT_HERE = /^(Not available here|Not found|Not available offline|Could not load|This page could not load|Board not found|Run not found|No such job|Branch or tag not found|Log not available|Forgejo could not load)$/;

/** Same-origin answers ≥ 400 that are expected, with why (add one only with the reason it is not a defect). Everything else fails the crawl. */
const EXPECTED_HTTP: {status: number; path: RegExp; why: string}[] = [
  {
    status: 404, path: /^\/api\/v1\/orgs\/[^/]+$/,
    why: 'the page of an owner this device does not know asks the org endpoint whether it is an organization (API v1 users have no type): 404 is a user',
  },
];

/** The ⌘K commands that navigate (others change the theme, sign out, or open classic pages). */
const PALETTE = ['Go to the inbox', 'Go to my issues', 'Go to my pull requests', 'Go to the board', 'Go home', 'Your profile and repositories'];
const PALETTE_IN_REPO = ['Go to the code of this repository'];

type Step =
  | {kind: 'link'; href: string; menu?: string}
  | {kind: 'card'}
  | {kind: 'palette'; label: string};

interface Visit {
  /** The page the step starts from (where the link was seen). */
  from: string;
  step: Step;
  depth: number;
  /** What was clicked ("Inbox", "#3 A title", "⌘K Go home"). */
  label: string;
}

interface Seen {
  href: string;
  text: string;
  classic: boolean;
  blank: boolean;
  download: boolean;
  menu?: string;
}

/** A path as a route pattern: owners, repositories, numbers, SHAs and file paths become placeholders. */
function routePattern(href: string): string {
  const url = new URL(href, BASE);
  const segs = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const out: string[] = [];
  const word = (s: string) => (/^\d+$/.test(s) ? ':n' : /^[\da-f]{40}$/.test(s) ? ':sha' : /^new-[\da-f-]{36}$/.test(s) ? ':temp' : s);
  if (segs[0] === '-' && segs[1] === 'next') {
    out.push('-', 'next');
    const rest = segs.slice(2);
    if (rest[0] === 'code') {
      // code/:owner/:repo/<view>[/<kind>[/<ref>[/…path]]]/-
      const [, , , view = '', ...tail] = rest;
      const path = tail.filter((s) => s !== '-');
      out.push('code', ':owner', ':repo', view);
      if (['src', 'blame', 'commits'].includes(view) && ['branch', 'tag', 'commit'].includes(path[0] ?? '')) {
        out.push(path[0] ?? '', ':ref');
        const file = path.slice(2);
        // A name with an extension is taken for a file (".forgejo", "Makefile" are taken for directories).
        if (file.length) out.push(/^[^.].*\.\w+$/.test(file.at(-1) ?? '') ? ':file' : ':dir');
      } else {
        out.push(...path.map((s, i) => (view === 'compare' || (view === 'branches' && i === 0) ? ':refs' : word(s))));
      }
    } else if (rest.length === 1 && !['boards', 'gallery'].includes(rest[0] ?? '')) {
      out.push(':owner');
    } else {
      out.push(...rest.map(word));
    }
  } else if (segs.length >= 1 && !['notifications', 'issues', 'pulls'].includes(segs[0] ?? '')) {
    out.push(':owner', ...(segs.length > 1 ? [':repo'] : []), ...segs.slice(2).map(word));
  } else {
    out.push(...segs.map(word));
  }
  const keys = [...url.searchParams.keys()].filter((k) => k !== 'q').sort()
    .map((k) => (['tab', 'type', 'filter', 'state', 'group'].includes(k) ? `${k}=${url.searchParams.get(k) ?? ''}` : k));
  return `/${out.join('/')}${keys.length ? `?${keys.join('&')}` : ''}`;
}

/** Whether a same-origin URL is a page of the app (SPA-only routes, or a canonical route not asking for the classic page). */
function inApp(url: URL): boolean {
  if (url.pathname.startsWith('/-/next/')) return !url.pathname.startsWith('/-/next/assets/');
  return isSpaRoute(url.pathname) && !url.searchParams.has('ui');
}

/** Waits until the page settled after a click: loaded, no skeletons or busy regions in the page. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0, {timeout: 8_000}).catch(() => undefined);
  await page.waitForTimeout(250);
}

/** The links a user can click on the page (visible anchors), and those in the menus of headers and the sidebar. */
async function linksOf(page: Page): Promise<Seen[]> {
  const read = (scope: Locator, menu?: string) => scope.evaluateAll((as, m) => as.filter((a) => a.getClientRects().length > 0).map((a) => {
    const el = a as HTMLAnchorElement;
    return {
      href: el.getAttribute('href') ?? '', text: el.innerText.trim().replace(/\s+/g, ' ').slice(0, 60), classic: el.hasAttribute('data-classic'),
      blank: el.target === '_blank', download: el.hasAttribute('download'), ...(m ? {menu: m} : {}),
    };
  }), menu);
  const out = await read(page.locator('a[href]'));
  // Menus in the page's headers and the sidebar (a repository's "More", the account menu).
  const triggers = page.locator('header button[aria-haspopup="menu"], aside[aria-label="Sidebar"] button[aria-haspopup="menu"]');
  const names = (await triggers.evaluateAll((bs) => bs.filter((b) => b.getClientRects().length > 0).map((b) => b.getAttribute('aria-label') ?? (b as HTMLElement).innerText.trim())))
    .filter((n, i, all) => n && all.indexOf(n) === i);
  for (const name of names) {
    const trigger = triggers.filter({hasText: name}).or(page.locator(`header button[aria-haspopup="menu"][aria-label=${JSON.stringify(name)}], aside button[aria-haspopup="menu"][aria-label=${JSON.stringify(name)}]`)).first();
    if (!await trigger.isVisible()) continue;
    await trigger.click();
    const menu = page.getByRole('menu').last();
    if (await menu.isVisible().catch(() => false)) out.push(...await read(menu.locator('a[href]'), name));
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  }
  return out;
}

/** The dead-end message the page shows, if any. */
async function deadEnd(page: Page): Promise<string | undefined> {
  const text = await page.getByRole('main').innerText().catch(() => '');
  return text.split('\n').map((l) => l.trim()).find((l) => NOT_HERE.test(l));
}

test.beforeAll(async ({browser}) => {
  test.setTimeout(5 * 60_000);
  await ensureUser(ALICE.user);
  // A repository of dev with code, history, a branch, a pull request with a review, a release with an asset,
  // a workflow (its runs wait: there is no runner), labels, a milestone, issues in every state, a board, and
  // notifications for dev; an organization with a repository of its own.
  await ok(await api('POST', '/user/repos', {name: REPO, auto_init: true, default_branch: 'main', description: 'The link crawler\'s repository'}), 'create repo');
  await ok(await api('PUT', `/repos/${USER}/${REPO}/collaborators/alice`, {permission: 'write'}), 'collaborator');
  await ok(await api('PATCH', `/repos/${USER}/${REPO}`, {has_actions: true, has_projects: true}), 'units');
  await changeFiles(REPO, {
    branch: 'main', message: 'Sources, docs and CI',
    files: [
      {operation: 'create', path: 'src/main.go', content: b64(goFile(20))},
      {operation: 'create', path: 'docs/guide.md', content: b64('# Guide\n\nSee [the main program](../src/main.go) and #1.\n\n```go\nfunc main() {}\n```\n')},
      {operation: 'create', path: 'docs/logo.svg', content: b64('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="teal"/></svg>\n')},
      {operation: 'create', path: '.forgejo/workflows/ci.yml', content: b64('on: [push, pull_request]\njobs:\n  test:\n    runs-on: crawl-runner\n    steps:\n      - run: echo test\n')},
    ],
  });
  const main = await apiJson<{sha: string}>('GET', `/repos/${USER}/${REPO}/contents/src/main.go`);
  await changeFiles(REPO, {branch: 'main', new_branch: 'feature', message: 'A feature', files: [
    {operation: 'update', path: 'src/main.go', content: b64(goFile(22)), sha: main.sha},
  ]}, alice);
  const pull = await apiJson<{number: number; head: {sha: string}}>('POST', `/repos/${USER}/${REPO}/pulls`, {head: 'feature', base: 'main', title: 'Add two functions', body: 'Ready for review, @dev.'}, alice);
  await ok(await api('POST', `/repos/${USER}/${REPO}/pulls/${String(pull.number)}/requested_reviewers`, {reviewers: [USER]}, alice), 'review request');
  await ok(await api('POST', `/repos/${USER}/${REPO}/pulls/${String(pull.number)}/reviews`, {
    event: 'COMMENT', body: 'A first look', commit_id: pull.head.sha, comments: [{path: 'src/main.go', new_position: 106, body: 'Why this name?'}],
  }), 'review');
  const release = await apiJson<{id: number}>('POST', `/repos/${USER}/${REPO}/releases`, {tag_name: 'v1.0.0', name: '1.0.0', target_commitish: 'main', body: 'The first release.'});
  const form = new FormData();
  form.append('attachment', new Blob(['abc  crawl.tar.gz\n']), 'SHA256SUMS');
  await ok(await fetch(`${BASE}/api/v1/repos/${USER}/${REPO}/releases/${String(release.id)}/assets?name=SHA256SUMS`, {method: 'POST', headers: {Authorization: `Basic ${Buffer.from(`${USER}:devdevdev1`).toString('base64')}`}, body: form}), 'asset');
  const label = async (name: string, color: string, exclusive = false) => (await apiJson<{id: number}>('POST', `/repos/${USER}/${REPO}/labels`, {name, color, exclusive})).id;
  const bug = await label('bug', '#d73a4a');
  const todo = await label('status/todo', '#0075ca', true);
  const high = await label('priority/high', '#e99695', true);
  const milestone = await apiJson<{id: number}>('POST', `/repos/${USER}/${REPO}/milestones`, {title: 'v1.1', description: 'Next'});
  const issues: {id: number; number: number}[] = [];
  const issue = async (title: string, body: string, extra: object = {}, as?: string) => {
    const i = await apiJson<{id: number; number: number}>('POST', `/repos/${USER}/${REPO}/issues`, {title, body, ...extra}, as);
    issues.push(i);
    return i;
  };
  await issue('The tile cache never shrinks', 'Steps:\n\n1. Start\n2. Wait\n\n- [ ] a task\n- [x] a done task', {labels: [bug, todo, high], milestone: milestone.id, assignees: [USER]});
  await issue('Document the configuration', `See #1 and ${REPO}#1; asks @${USER}.`, {labels: [todo]}, alice);
  const closed = await issue('An old question', 'Answered.');
  await ok(await api('PATCH', `/repos/${USER}/${REPO}/issues/${String(closed.number)}`, {state: 'closed'}), 'close');
  await ok(await api('POST', `/repos/${USER}/${REPO}/issues/1/comments`, {body: `I can reproduce it, @${USER}.`}, alice), 'comment');
  // A commit that names issue 2 (#1 is the pull request): its timeline shows the reference (from the server's HTML).
  await changeFiles(REPO, {branch: 'main', message: 'Shrink the tile cache, refs #2', files: [
    {operation: 'create', path: 'NOTES.md', content: b64('Notes.\n')},
  ]});
  await ok(await api('POST', '/orgs', {username: ORG, visibility: 'public'}), 'org');
  await ok(await api('POST', `/orgs/${ORG}/repos`, {name: 'site', auto_init: true, default_branch: 'main'}), 'org repo');
  await ok(await api('POST', `/repos/${ORG}/site/issues`, {title: 'The site needs a footer', body: ''}), 'org issue');
  // A board (API v1 has no projects endpoints: the classic form, signed in).
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  await classicProject(page, USER, REPO, 'Crawl board', issues);
  await ctx.close();
});

test('the link crawler: every in-app link leads to a page of the app, without errors @crawl', async ({browser}, testInfo) => {
  test.setTimeout(15 * 60_000);
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  const http: string[] = [];
  page.on('response', (r) => {
    const url = new URL(r.url());
    if (url.origin !== new URL(BASE).origin || r.status() < 400) return;
    // The classic login and consent pages have no built assets on these servers (not the app's).
    if (/^\/(?:assets|user\/login|login\/oauth)\b/.test(url.pathname)) return;
    if (EXPECTED_HTTP.some((e) => e.status === r.status() && e.path.test(url.pathname))) return;
    http.push(`${String(r.status())} ${r.request().method()} ${url.pathname}${url.search} (on ${new URL(page.url()).pathname})`);
  });
  const failures: string[] = [];
  const visited: {pattern: string; url: string; via: string; depth: number}[] = [];
  const patterns = new Set<string>();
  const counts = {links: 0, classic: 0, newTab: 0, download: 0, external: 0, duplicate: 0, tooDeep: 0};
  /** Classic exits by route pattern (each address is requested once after the walk). */
  const classicExits = new Map<string, {href: string; from: string; text: string}>();
  const queue: Visit[] = [];
  const origin = new URL(BASE).origin;

  const plan = (from: string, links: Seen[], depth: number) => {
    for (const l of links) {
      counts.links++;
      const url = new URL(l.href, from);
      if (url.origin !== origin) {
        counts.external++;
        continue;
      }
      if (l.blank) {
        counts.newTab++;
        continue;
      }
      if (l.download) {
        counts.download++;
        continue;
      }
      if (l.classic) {
        counts.classic++;
        const key = routePattern(url.href);
        if (!classicExits.has(key)) classicExits.set(key, {href: url.href, from, text: l.text});
        continue;
      }
      if (!inApp(url)) {
        failures.push(`a link leaves the app without saying so: "${l.text}" → ${url.pathname}${url.search} (on ${new URL(from).pathname})`);
        continue;
      }
      const p = routePattern(url.href);
      if (patterns.has(p)) {
        counts.duplicate++;
        continue;
      }
      if (depth + 1 > MAX_DEPTH) {
        counts.tooDeep++;
        continue;
      }
      patterns.add(p);
      queue.push({from, step: {kind: 'link', href: l.href, ...(l.menu ? {menu: l.menu} : {})}, depth: depth + 1, label: l.menu ? `${l.menu} › ${l.text}` : l.text || l.href});
    }
  };

  const look = async (v: Visit | undefined) => {
    await settle(page);
    const url = page.url();
    const via = v ? `${v.label} (from ${new URL(v.from).pathname})` : 'start';
    const pattern = routePattern(url);
    visited.push({pattern, url: new URL(url).pathname + new URL(url).search, via, depth: v?.depth ?? 0});
    patterns.add(pattern);
    if (!await page.locator('aside[aria-label="Sidebar"]').count()) {
      failures.push(`left the app: ${via} → ${url}`);
      return;
    }
    const dead = await deadEnd(page);
    if (dead) failures.push(`"${dead}": ${via} → ${new URL(url).pathname}`);
    const depth = v?.depth ?? 0;
    // An issue or a pull request page lets the user go (sidebar Home) and come back (Back).
    if (/^\/:owner\/:repo\/(?:issues|pulls)\/:n/.test(pattern) && !patterns.has(`leave:${pattern}`)) {
      patterns.add(`leave:${pattern}`);
      await page.locator('aside[aria-label="Sidebar"]').getByRole('link', {name: 'Home', exact: true}).first().click();
      await page.waitForURL((u) => u.pathname === '/', {timeout: 10_000}).catch(() => undefined);
      await page.waitForTimeout(500);
      if (new URL(page.url()).pathname !== '/') failures.push(`could not leave ${new URL(url).pathname} by the sidebar's Home: still at ${new URL(page.url()).pathname}`);
      await page.goBack();
      await page.waitForURL((u) => u.pathname === new URL(url).pathname, {timeout: 10_000}).catch(() => undefined);
      if (new URL(page.url()).pathname !== new URL(url).pathname) failures.push(`Back from Home did not return to ${new URL(url).pathname}: at ${new URL(page.url()).pathname}`);
      await settle(page);
    }
    plan(url, await linksOf(page), depth);
    // A board's cards are not anchors (drag and drop): the first one is clicked.
    if (await page.locator('[data-card]').count() && !patterns.has('board-card') && depth < MAX_DEPTH) {
      patterns.add('board-card');
      queue.push({from: url, step: {kind: 'card'}, depth: depth + 1, label: 'the first card'});
    }
    // The palette's navigation commands (once each).
    const path = new URL(url).pathname;
    const inRepo = /^\/(?!-\/)[^/]+\/[^/]+/.test(path) || path.startsWith('/-/next/code/');
    const commands = [...PALETTE, ...(inRepo ? PALETTE_IN_REPO : [])];
    for (const label of commands) {
      if (patterns.has(`palette:${label}`) || depth >= MAX_DEPTH) continue;
      patterns.add(`palette:${label}`);
      queue.push({from: url, step: {kind: 'palette', label}, depth: depth + 1, label: `⌘K ${label}`});
    }
  };

  await look(undefined);
  while (queue.length && visited.length < MAX_VISITS) {
    const v = queue.shift();
    if (!v) break;
    if (page.url() !== v.from) {
      await page.goto(v.from);
      await settle(page);
    }
    const before = page.url();
    try {
      if (v.step.kind === 'link') {
        const step = v.step;
        if (step.menu) {
          await page.locator('header button[aria-haspopup="menu"], aside[aria-label="Sidebar"] button[aria-haspopup="menu"]')
            .filter({hasText: step.menu}).or(page.locator(`button[aria-haspopup="menu"][aria-label=${JSON.stringify(step.menu)}]`)).first().click();
          await page.getByRole('menu').last().locator(`a[href=${JSON.stringify(step.href)}]`).first().click();
        } else {
          await page.locator(`a[href=${JSON.stringify(step.href)}]`).filter({visible: true}).first().click();
        }
        const target = new URL(step.href, before);
        if (target.pathname !== new URL(before).pathname) {
          await page.waitForURL((u) => u.pathname === target.pathname, {timeout: 15_000}).catch(() => undefined);
          // It must stay there (a page that is leaving must not send the user back to itself).
          await page.waitForTimeout(400);
          const at = new URL(page.url()).pathname;
          if (at !== target.pathname && target.pathname !== '/-/next/' && target.pathname !== '/-/next') {
            failures.push(`a click did not arrive: ${v.label} on ${new URL(v.from).pathname} → ${target.pathname}, but the page is ${at}`);
          }
        }
      } else if (v.step.kind === 'card') {
        await page.locator('[data-card]').first().click();
        await page.waitForURL((u) => u.href !== before, {timeout: 15_000}).catch(() => undefined);
      } else {
        await page.keyboard.press('ControlOrMeta+k');
        await page.getByRole('combobox').fill(v.step.label);
        await page.getByRole('option', {name: v.step.label}).first().click();
        await page.waitForURL((u) => u.href !== before, {timeout: 15_000}).catch(() => undefined);
      }
    } catch (e) {
      failures.push(`could not click ${v.label} on ${new URL(v.from).pathname}: ${(e as Error).message.split('\n')[0] ?? ''}`);
      await page.keyboard.press('Escape');
      continue;
    }
    await look(v);
  }

  // Addresses a user types or comes back to, which no in-app link produces (QA 2026-10-09: both slipped past the
  // link walk). Search values that read as numbers or booleans (?q=8 once crashed the list), and the classic UI's
  // "Back to Forgejo Next" pill on pages the app has no view of (or a view under another address).
  const typed = [
    `/${USER}/${REPO}/issues?q=8`, `/${USER}/${REPO}/issues?q=true`, `/${USER}/${REPO}/pulls?q=1&labels=1`, '/issues?q=false', '/notifications?q=1',
    `/${USER}/${REPO}/issues?type=assigned`,
    // Pasted code addresses (QA round 2: they always opened the classic UI).
    `/${USER}/${REPO}/src/branch/main`, `/${USER}/${REPO}/src/branch/main/README.md`, `/${USER}/${REPO}/commits/branch/main`, `/${USER}/${REPO}/branches`,
    `/${USER}/${REPO}/releases`, `/${USER}/${REPO}/actions`, `/${USER}/${REPO}/pulls/1/files`,
  ];
  for (const path of typed) {
    await page.goto(new URL(path, BASE).href);
    await settle(page);
    const via = `typed ${path}`;
    visited.push({pattern: `typed:${path}`, url: path, via, depth: 0});
    const dead = await deadEnd(page);
    if (dead) failures.push(`"${dead}": ${via}`);
    if (!await page.locator('aside[aria-label="Sidebar"]').count()) failures.push(`left the app: ${via} → ${page.url()}`);
  }
  const classicPages = [
    `/${USER}/${REPO}/projects`, `/${USER}/${REPO}/pulls/1/files?ui=classic`, `/${USER}/${REPO}/milestones`, `/${USER}/${REPO}/settings`,
    `/${USER}?tab=activity`, '/explore/repos', `/${USER}/${REPO}/issues/2?ui=classic`, `/${USER}/${REPO}/labels`, `/${USER}/${REPO}/activity`,
    `/${USER}/${REPO}/issues/new`,
  ];
  // A repository's classic page comes back to that repository (its home, a tab, its boards), never to Home.
  const repoPrefix = [`/${USER}/${REPO}`, `/-/next/code/${USER}/${REPO}/`, '/-/next/boards', '/-/next/projects/'];
  for (const path of classicPages) {
    await page.goto(new URL(path, BASE).href);
    await page.waitForLoadState('domcontentloaded');
    const pill = page.locator('#forgejo-next-toggle a').first();
    const via = `the classic pill on ${path}`;
    visited.push({pattern: `classic:${path}`, url: path, via, depth: 0});
    // The pill is added by a deferred script on the classic page.
    await pill.waitFor({timeout: 10_000}).catch(() => undefined);
    if (!await pill.count()) {
      failures.push(`no "Back to Forgejo Next" pill on the classic page ${path} (at ${page.url()}, "${await page.title()}", app: ${String(await page.locator('aside[aria-label="Sidebar"]').count())})`);
      continue;
    }
    await pill.click();
    await page.waitForURL((u) => u.pathname + u.search !== path, {timeout: 15_000}).catch(() => undefined);
    await settle(page);
    if (!await page.locator('aside[aria-label="Sidebar"]').count()) {
      failures.push(`left the app: ${via} → ${page.url()}`);
      continue;
    }
    const dead = await deadEnd(page);
    if (dead) failures.push(`"${dead}": ${via} → ${new URL(page.url()).pathname}`);
    const landed = new URL(page.url()).pathname;
    if (path.startsWith(`/${USER}/${REPO}/`) && !repoPrefix.some((p) => landed.startsWith(p))) failures.push(`${via} left the repository: ${landed}`);
  }

  // Every classic exit (one per route pattern) names a page the classic UI has: "This page classic" on a code
  // view once led to /{owner}/{repo}/src, a 404 (QA round 2).
  for (const [pattern, exit] of classicExits) {
    const res = await page.request.get(exit.href, {maxRedirects: 5, failOnStatusCode: false});
    visited.push({pattern: `classic-exit:${pattern}`, url: exit.href, via: `"${exit.text}" on ${new URL(exit.from).pathname}`, depth: 0});
    if (res.status() >= 400) failures.push(`a classic exit leads to HTTP ${String(res.status())}: "${exit.text}" on ${new URL(exit.from).pathname} → ${new URL(exit.href).pathname}${new URL(exit.href).search}`);
  }

  const report = {
    visits: visited.length, patterns: [...new Set(visited.map((x) => x.pattern))].sort(), counts, failures, http, problems: [...new Set(problems)],
    visited,
  };
  await testInfo.attach('crawl-coverage.json', {body: JSON.stringify(report, null, 2), contentType: 'application/json'});
  console.log(`crawl: ${String(visited.length)} pages visited, ${String(report.patterns.length)} route patterns; links seen ${String(counts.links)} ` +
    `(${String(counts.duplicate)} to patterns already visited, ${String(counts.classic)} classic exits, ${String(counts.newTab)} new tabs, ` +
    `${String(counts.download)} downloads, ${String(counts.external)} external, ${String(counts.tooDeep)} beyond depth ${String(MAX_DEPTH)})`);
  for (const x of visited) console.log(`  ${x.pattern.padEnd(64)} ${'·'.repeat(x.depth)} ${x.via}`);
  await ctx.close();
  expect(failures, 'dead ends and unmarked exits').toEqual([]);
  expect(http, 'same-origin HTTP errors').toEqual([]);
  expect(report.problems, 'page errors and console errors').toEqual([]);
  expect(report.patterns.length).toBeGreaterThanOrEqual(MIN_PATTERNS);
});
