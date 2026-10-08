// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Daily work (F6) against a real Forgejo with livesync serving this build:
// inbox triage (J/K, E/U/Shift+P, G N) and read state across tabs; a board — drag and drop that a second user sees and the
// classic UI agrees with, keyboard moves, columns; creating an issue
// offline, commenting on it, and the sync replacing its temporary URL;
// search speed on thousands of issues and the server's fallback; saved
// views; the CodeMirror composer with Forgejo's preview (and no script
// from it), reactions and subscribing. Seeded with tools/seed-issues.ts
// (repositories f6 and, for search, NEXT_E2E_SEARCH_REPO with
// NEXT_E2E_SEARCH_ISSUES issues).

import {expect, type Page, test} from '@playwright/test';
import {api, type ApiIssue, newIssue as createIssue, seed} from '../lib/api.ts';
import {indicator, signedIn, watch} from '../lib/app.ts';
import {goOffline, goOnline} from '../lib/device.ts';
import {ALICE, aliceAuth as alice, BASE, USER} from '../lib/env.ts';
import {record} from '../lib/perf.ts';
import {classicColumn as classicColumnOf, classicProject as classicProjectOf} from '../lib/projects.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

const REPO = 'f6';
const SEARCH_REPO = process.env.NEXT_E2E_SEARCH_REPO ?? 'f6search';
const SEARCH_ISSUES = Number(process.env.NEXT_E2E_SEARCH_ISSUES ?? 3000);

test.beforeAll(async () => {
  test.setTimeout(30 * 60_000);
  seed(REPO, 12);
  // Titles and bodies are all search needs.
  seed(SEARCH_REPO, SEARCH_ISSUES, {concurrency: 16, plain: true});
  await api('PUT', `/repos/${USER}/${REPO}/collaborators/alice`, {permission: 'write'});
});

const newIssue = (title: string, body = '') => createIssue(USER, REPO, title, body);

/** The User Timing measures of a name taken so far (durations, ms). */
async function measures(page: Page, name: string): Promise<number[]> {
  return page.evaluate((n) => performance.getEntriesByName(n, 'measure').map((m) => m.duration), name);
}

// ── Inbox ──────────────────────────────────────────────────────────────────

test('inbox: G N, J/K triage with E/U/Shift+P, read state in another tab and on the server', async ({browser}) => {
  // Two threads with news for dev: alice comments on issues dev opened (posters are subscribed).
  const a = await newIssue(`Inbox one ${String(Date.now())}`);
  const b = await newIssue(`Inbox two ${String(Date.now())}`);
  for (const i of [a, b]) {
    expect((await api('POST', `/repos/${USER}/${REPO}/issues/${String(i.number)}/comments`, {body: 'A reply from alice'}, alice)).status).toBe(201);
  }
  // The notifier runs in a queue.
  await expect.poll(async () => {
    const list = await (await api('GET', '/notifications?status-types=unread&limit=50')).json() as {subject: {title: string}}[];
    return [a, b].every((i) => list.some((n) => n.subject.title === i.title));
  }, {timeout: 30_000}).toBe(true);

  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  const other = await ctx.newPage();
  await other.goto(`${BASE}/notifications`);
  await page.keyboard.press('g');
  await page.keyboard.press('n');
  await expect(page).toHaveURL(`${BASE}/notifications`);
  const list = page.getByRole('listbox', {name: 'Notifications'});
  const row = (p: Page, title: string) => p.getByRole('listbox', {name: 'Notifications'}).getByRole('option').filter({hasText: title});
  await expect(row(page, b.title)).toBeVisible({timeout: 20_000});
  await expect(row(page, a.title)).toBeVisible();
  await expect(row(page, b.title)).toContainText('Unread:');
  const unread = async () => Number(await page.getByRole('navigation', {name: 'Main'}).getByRole('link', {name: /Inbox/}).innerText().then((t) => /\d+/.exec(t)?.[0] ?? '0'));
  const before = await unread();

  // J to the newest (b), E marks it read: at once here, then in the other tab, then on the server.
  // Focus puts the cursor on the first row; J/K walk to b.
  await list.focus();
  const ids = await list.getByRole('option').evaluateAll((els) => els.map((e) => e.textContent));
  const at = ids.findIndex((t) => t.includes(b.title));
  for (let i = 0; i < at; i++) await page.keyboard.press('j');
  await expect(row(page, b.title)).toHaveAttribute('data-active', '');
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await expect(row(page, b.title)).toHaveAttribute('data-active', '');
  const t0 = await page.evaluate(() => performance.now());
  await page.keyboard.press('e');
  await expect(row(page, b.title)).not.toContainText('Unread:');
  const applied = await page.evaluate((s) => performance.now() - s, t0);
  record('inbox: E → row repainted (ms, incl. Playwright round trip)', [applied]);
  expect(await unread()).toBe(before - 1);
  await expect(row(other, b.title)).toBeVisible();
  await expect(row(other, b.title)).not.toContainText('Unread:', {timeout: 15_000});
  await expect.poll(async () => {
    const l = await (await api('GET', '/notifications?status-types=read&limit=50')).json() as {subject: {title: string}}[];
    return l.some((n) => n.subject.title === b.title);
  }, {timeout: 15_000}).toBe(true);

  // Every state the row shows from here on (MutationObserver), and the keys: a status confirmed by the
  // server must never flicker back to the previous one (notifications are a hot table: the write's sync-id
  // echo may not cover it, B7).
  await page.evaluate((title) => {
    const w = window as unknown as {__seen: string[]};
    w.__seen = [];
    const state = () => {
      const r = [...document.querySelectorAll('[role=listbox][aria-label=Notifications] [role=option]')].find((e) => e.textContent.includes(title));
      const t = r?.textContent ?? '';
      return t.startsWith('Pinned:') ? 'pinned' : t.startsWith('Unread:') ? 'unread' : r ? 'read' : 'gone';
    };
    new MutationObserver(() => {
      const s = state();
      if (w.__seen.at(-1) !== s) w.__seen.push(s);
    }).observe(document.body, {subtree: true, childList: true, characterData: true});
    addEventListener('keydown', (e) => {
      if (e.key === 'P') w.__seen.push('key P');
    }, true);
  }, b.title);
  // U: unread again. Shift+P: pinned (its own group). K / J move between rows.
  await page.keyboard.press('u');
  await expect(row(page, b.title)).toContainText('Unread:');
  await page.keyboard.press('Shift+P');
  await expect(list.getByText('Pinned', {exact: true})).toBeVisible();
  await expect(row(page, b.title)).toContainText('Pinned:');
  await expect.poll(async () => {
    const l = await (await api('GET', '/notifications?status-types=pinned&limit=50')).json() as {subject: {title: string}}[];
    return l.some((n) => n.subject.title === b.title);
  }, {timeout: 15_000}).toBe(true);
  await page.keyboard.press('Shift+P');
  await expect(row(page, b.title)).not.toContainText('Pinned:');
  // Give a late echo the time to show (HOT_COALESCE is 1 s), then check that the row went unread → pinned →
  // read, each once: no flicker back.
  await page.waitForTimeout(1500);
  const seen = await page.evaluate(() => (window as unknown as {__seen: string[]}).__seen);
  expect(seen.filter((x) => x !== 'gone'), JSON.stringify(seen)).toEqual(['unread', 'key P', 'pinned', 'key P', 'read']);

  // Enter opens the issue (and reads it).
  await row(page, a.title).click();
  await expect(page).toHaveURL(`${BASE}/${USER}/${REPO}/issues/${String(a.number)}`);
  await expect.poll(async () => {
    const l = await (await api('GET', '/notifications?status-types=unread&limit=50')).json() as {subject: {title: string}}[];
    return l.some((n) => n.subject.title === a.title);
  }, {timeout: 15_000}).toBe(false);
  expect(problems).toEqual([]);
  await ctx.close();
});

// ── Boards ─────────────────────────────────────────────────────────────────

const classicProject = (page: Page, title: string, issues: ApiIssue[]) => classicProjectOf(page, USER, REPO, title, issues);
const classicColumn = (page: Page, projectId: number, issue: ApiIssue) => classicColumnOf(page, USER, REPO, projectId, issue);

test('board: drag and drop converges for a second user and in the classic UI; keyboard moves; columns', async ({browser}) => {
  const stamp = String(Date.now());
  const first = await newIssue(`Card A ${stamp}`);
  const cards = [first, await newIssue(`Card B ${stamp}`), await newIssue(`Card C ${stamp}`)];
  const devCtx = await browser.newContext();
  const page = await signedIn(devCtx);
  const problems = watch(page);
  const pid = await classicProject(page, `Board ${stamp}`, cards);
  const aliceCtx = await browser.newContext();
  const other = await signedIn(aliceCtx, ALICE);

  await page.goto(`${BASE}/-/next/projects/${String(pid)}`);
  await other.goto(`${BASE}/-/next/projects/${String(pid)}`);
  const column = (p: Page, name: string) => p.locator('section[data-column]').filter({has: p.getByRole('heading', {name, exact: true})});
  const card = (p: Page, t: string) => p.getByRole('option').filter({hasText: t});
  await expect(card(page, cards[0]?.title ?? '')).toBeVisible({timeout: 30_000});
  await expect(card(other, cards[0]?.title ?? '')).toBeVisible({timeout: 30_000});
  const titles = await page.locator('section[data-column] h2').allInnerTexts();
  expect(titles.length).toBeGreaterThanOrEqual(3);
  const fromCol = column(page, titles[0] ?? '');
  await expect(fromCol.getByRole('option')).toHaveCount(3);
  const target = titles[1] ?? '';

  // Drag card A into the second column, measuring frames while the pointer moves.
  const src = card(page, cards[0]?.title ?? '');
  const box = await src.boundingBox();
  const dest = await column(page, target).boundingBox();
  if (!box || !dest) throw new Error('no geometry');
  await page.evaluate(() => {
    const w = window as unknown as {__frames: number[]; __stop: boolean};
    w.__frames = [];
    w.__stop = false;
    let last = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - last);
      last = t;
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + box.width / 2 + ((dest.x + dest.width / 2 - box.x - box.width / 2) * i) / 30, box.y + 40 + i);
  await page.mouse.up();
  const frames = await page.evaluate(() => {
    const w = window as unknown as {__frames: number[]; __stop: boolean};
    w.__stop = true;
    return w.__frames.slice(1);
  });
  record('board drag: frame interval (ms)', frames);
  await expect(column(page, target).getByRole('option').filter({hasText: cards[0]?.title ?? ''})).toBeVisible();
  // The second user, and the classic page, see it there.
  await expect(column(other, target).getByRole('option').filter({hasText: cards[0]?.title ?? ''})).toBeVisible({timeout: 15_000});
  await expect.poll(() => classicColumn(page, pid, first), {timeout: 15_000}).toBe(target);

  // Released outside the board (over the sidebar): nothing moves.
  const before = await column(page, target).getByRole('option').allInnerTexts();
  const a2 = await card(page, first.title).boundingBox();
  if (!a2) throw new Error('no geometry');
  await page.mouse.move(a2.x + a2.width / 2, a2.y + a2.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(a2.x + a2.width / 2 - i * 60, a2.y + 20);
  await page.mouse.move(20, 200);
  await page.mouse.up();
  expect(await column(page, target).getByRole('option').allInnerTexts()).toEqual(before);

  // Keyboard: plain L/H move the cursor between columns (L is not the labels picker on a board).
  await column(page, target).getByRole('listbox').focus();
  await page.keyboard.press('h');
  await expect(fromCol.locator('[data-active]')).toHaveCount(1);
  await page.keyboard.press('l');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(column(page, target).locator('[data-active]')).toHaveCount(1);
  // Keyboard: Shift+L moves a card one column right.
  // (The drag focused the column it started in; focusing another column puts the cursor on its first card.)
  await column(page, target).getByRole('listbox').focus();
  await column(page, titles[0] ?? '').getByRole('listbox').focus();
  await expect(fromCol.getByRole('option').first()).toHaveAttribute('data-active', '');
  const activeTitle = await fromCol.getByRole('option').first().innerText();
  await page.keyboard.press('Shift+L');
  await expect(column(page, target).getByRole('option').filter({hasText: activeTitle.split('\n').find((l) => l.includes(stamp)) ?? stamp})).toBeVisible();
  await expect(column(other, target).getByRole('option')).toHaveCount(2, {timeout: 15_000});

  // Columns (online): add one, it shows for both.
  await page.getByRole('button', {name: 'Add column'}).click();
  await page.getByRole('textbox', {name: 'New column name'}).fill(`QA ${stamp}`);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', {name: `QA ${stamp}`})).toBeVisible({timeout: 15_000});
  await expect(other.getByRole('heading', {name: `QA ${stamp}`})).toBeVisible({timeout: 15_000});
  // Offline, column changes say why; card moves still work (queued).
  await goOffline(devCtx, page);
  await expect(page.getByRole('button', {name: 'Add column'})).toBeDisabled();
  const lastCard = column(page, target).getByRole('option').first();
  const lastText = await lastCard.innerText();
  const lastTitle = lastText.split('\n').find((l) => l.includes(stamp)) ?? '';
  await column(page, target).getByRole('listbox').focus();
  await page.keyboard.press('Shift+H');
  await expect(column(page, titles[0] ?? '').getByRole('option').filter({hasText: lastTitle})).toBeVisible();
  await goOnline(devCtx, page);
  await expect(column(other, titles[0] ?? '').getByRole('option').filter({hasText: lastTitle})).toBeVisible({timeout: 30_000});
  // Reordering within a column (Shift+K: up): the second user ends with the same order, card for card.
  const order = (p: Page) => column(p, titles[0] ?? '').getByRole('option').evaluateAll((els) => els.map((e) => /#\d+/.exec(e.textContent)?.[0] ?? ''));
  const start = await order(page);
  const moved = /#\d+/.exec(lastText)?.[0] ?? '';
  if (start.indexOf(moved) > 0) {
    await page.keyboard.press('Shift+K');
    await expect.poll(() => order(page)).not.toEqual(start);
  }
  const mine = await order(page);
  await expect.poll(() => order(other), {timeout: 30_000}).toEqual(mine);
  // G B comes back to this board.
  await page.goto(`${BASE}/issues`);
  await expect(page.getByRole('heading', {level: 1})).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('b');
  await expect(page).toHaveURL(`${BASE}/-/next/projects/${String(pid)}`);
  expect(problems).toEqual([]);
  await devCtx.close();
  await aliceCtx.close();
});

// ── Create offline ─────────────────────────────────────────────────────────

test('create offline: temporary id, a comment on it, then the sync numbers it and replaces the URL', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  await page.goto(`${BASE}/${USER}/${REPO}/issues`);
  await expect(page.getByRole('listbox', {name: /issues/i})).toBeVisible({timeout: 20_000});
  await goOffline(ctx, page);
  const title = `Made offline ${String(Date.now())}`;
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', {name: 'New issue'});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', {name: 'Title'}).fill(title);
  await dialog.getByRole('textbox', {name: 'Description'}).click();
  await page.keyboard.type('Written **offline**.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page).toHaveURL(new RegExp(`/${USER}/${REPO}/issues/new-[0-9a-f-]{36}$`));
  await expect(page.getByRole('heading', {level: 2, name: title})).toBeVisible();
  // A comment on the issue that does not exist on the server yet.
  await page.keyboard.press('r');
  await expect(page.getByRole('textbox', {name: 'Leave a comment'})).toBeFocused();
  await page.keyboard.type('First comment, also offline');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('region', {name: 'Activity'}).getByText('First comment, also offline')).toBeVisible();
  await goOnline(ctx, page);
  await expect(page).toHaveURL(new RegExp(`/${USER}/${REPO}/issues/\\d+$`), {timeout: 30_000});
  const n = Number(/\/issues\/(\d+)$/.exec(page.url())?.[1]);
  const created = await (await api('GET', `/repos/${USER}/${REPO}/issues/${String(n)}`)).json() as ApiIssue & {body: string};
  expect(created.title).toBe(title);
  expect(created.body).toBe('Written **offline**.');
  await expect.poll(async () => (await (await api('GET', `/repos/${USER}/${REPO}/issues/${String(n)}/comments`)).json() as {body: string}[]).map((c) => c.body), {timeout: 20_000})
    .toEqual(['First comment, also offline']);
  // Exactly one issue with that title.
  const same = await (await api('GET', `/repos/${USER}/${REPO}/issues?state=all&type=issues&limit=50`)).json() as ApiIssue[];
  expect(same.filter((i) => i.title === title)).toHaveLength(1);
  await expect(indicator(page)).not.toContainText('pending', {timeout: 20_000});
  expect(problems).toEqual([]);
  await ctx.close();
});

// ── Search ─────────────────────────────────────────────────────────────────

test('search: local results within a frame on thousands of issues, the server for the rest', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  // The search repository on this device.
  await page.goto(`${BASE}/${USER}/${SEARCH_REPO}/issues`);
  await expect(page.getByRole('listbox', {name: /issues/i}).getByRole('option').first()).toBeVisible({timeout: 60_000});
  const held = await page.evaluate(() => (performance.getEntriesByName('list:query', 'measure').at(-1) as PerformanceMeasure | undefined)?.detail as {rows?: number} | undefined);
  console.log('rows listed', held?.rows);
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox');
  // The index fills in the worker; then each keystroke is measured on both paths.
  // Queries from real titles: a word, two words, a prefix, a number.
  const some = await (await api('GET', `/repos/${USER}/${SEARCH_REPO}/issues?state=open&type=issues&limit=4`)).json() as ApiIssue[];
  const queries = some.flatMap((i) => {
    const w = i.title.toLowerCase().split(/\s+/);
    return [w[0] ?? '', `${w[0] ?? ''} ${w[1] ?? ''}`, (w[2] ?? '').slice(0, 4), `#${String(i.number)}`];
  });
  for (const q of queries) {
    await input.fill('');
    await input.pressSequentially(q, {delay: 30});
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.waitForTimeout(150);
  }
  const scan = await measures(page, 'palette:search');
  const local = await page.evaluate(() => (performance.getEntriesByName('search:local', 'measure') as PerformanceMeasure[]).map((m) => ({rtt: m.duration, worker: (m.detail as {worker: number}).worker, size: (m.detail as {size: number}).size})));
  record('palette scan (main thread, per keystroke)', scan);
  record('MiniSearch worker: round trip', local.map((l) => l.rtt));
  record('MiniSearch worker: search time', local.map((l) => l.worker));
  console.log('index size', local.at(-1)?.size);
  expect(local.at(-1)?.size ?? 0).toBeGreaterThan(SEARCH_ISSUES * 0.5);
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? Number.POSITIVE_INFINITY;
  expect(p95(scan)).toBeLessThan(16);
  expect(p95(local.map((l) => l.rtt))).toBeLessThan(16);
  // A typo finds it through the index (the scan does not).
  await input.fill('');
  await input.pressSequentially('notifcation', {delay: 20});
  await expect(page.getByRole('option', {name: /notification/i}).first()).toBeVisible({timeout: 5000});

  // A word only in a body: the server's search finds it ("On Forgejo").
  const token = `zebracorn${String(Date.now())}`;
  const hidden = await newIssue(`Body-only match ${String(Date.now())}`, `The word ${token} is only here.`);
  await input.fill('');
  await expect.poll(async () => {
    // Asked again each time (the server's indexer may lag the write).
    await input.fill('');
    await input.fill(token);
    await page.waitForTimeout(1000);
    return page.getByRole('option', {name: new RegExp(hidden.title)}).count();
  }, {timeout: 60_000}).toBeGreaterThan(0);
  expect(problems).toEqual([]);
  await ctx.close();
});

// ── Saved views ────────────────────────────────────────────────────────────

test('saved views: save a grouped, filtered list; it comes back from the sidebar and the palette, after a reload', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  await page.goto(`${BASE}/${USER}/${REPO}/issues?group=status&sort=oldest`);
  await expect(page.getByRole('listbox', {name: /issues/i})).toBeVisible({timeout: 20_000});
  await page.keyboard.press('Shift+V');
  const dialog = page.getByRole('dialog', {name: 'Save the view'});
  await dialog.getByRole('textbox', {name: 'View name'}).fill('Oldest by status');
  await page.keyboard.press('Enter');
  const item = page.getByRole('navigation', {name: 'Main'}).getByRole('link', {name: 'Oldest by status'});
  await expect(item).toBeVisible();
  await page.goto(`${BASE}/issues`);
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/${USER}/${REPO}/issues\\?(?=.*group=status)(?=.*sort=oldest)`));
  await expect(page.getByRole('main').getByText('Oldest by status', {exact: true})).toBeVisible();
  await page.reload();
  await expect(item).toBeVisible();
  await page.goto(`${BASE}/notifications`);
  await expect(page.getByRole('heading', {level: 1, name: 'Inbox'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', {name: 'Command menu'}).fill('oldest by');
  await page.getByRole('option', {name: 'Oldest by status'}).click();
  await expect(page).toHaveURL(/group=status/);
  await item.click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Remove the view'}).click();
  await expect(item).toHaveCount(0);
  expect(problems).toEqual([]);
  await ctx.close();
});

// ── Composer, preview, reactions, subscribing ──────────────────────────────

test('composer: CodeMirror with Forgejo\'s preview (scripts never run), reactions, subscribing', async ({browser}) => {
  const target = await newIssue(`Composer ${String(Date.now())}`, 'Body.');
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs++;
    void d.dismiss();
  });
  await page.goto(`${BASE}/${USER}/${REPO}/issues/${String(target.number)}`);
  await expect(page.getByRole('heading', {level: 2, name: target.title})).toBeVisible({timeout: 20_000});
  // R focuses the comment box: the CodeMirror editor (its own chunk).
  await page.keyboard.press('r');
  const editor = page.getByRole('textbox', {name: 'Leave a comment'});
  await expect(editor).toBeFocused();
  await expect(editor).toHaveClass(/cm-content/);
  const text = `**bold** and #${String(target.number)}\n\n<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>`;
  await page.keyboard.type(text);
  await page.keyboard.press('ControlOrMeta+Shift+P');
  const preview = page.locator('.prose').last();
  await expect(preview.locator('strong')).toHaveText('bold', {timeout: 10_000});
  await expect(preview.locator('script')).toHaveCount(0);
  await expect(preview.locator('[onerror]')).toHaveCount(0);
  expect(await preview.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? '').filter((h) => /^\s*javascript:/i.test(h)))).toEqual([]);
  await page.getByRole('button', {name: 'Write'}).click();
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('region', {name: 'Activity'}).locator('strong', {hasText: 'bold'})).toBeVisible({timeout: 20_000});
  await expect.poll(async () => (await (await api('GET', `/repos/${USER}/${REPO}/issues/${String(target.number)}/comments`)).json() as {body: string}[]).length, {timeout: 15_000}).toBe(1);

  // A reaction on the issue: counted at once, then on the server.
  await page.getByRole('button', {name: 'Add a reaction'}).first().click();
  await page.getByRole('menuitem', {name: 'Rocket', exact: true}).click();
  await expect(page.getByRole('button', {name: /you reacted with rocket/})).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await (await api('GET', `/repos/${USER}/${REPO}/issues/${String(target.number)}/reactions`)).json() as {content: string}[]).map((r) => r.content), {timeout: 15_000})
    .toEqual(['rocket']);
  await page.getByRole('button', {name: /you reacted with rocket/}).click();
  await expect.poll(async () => ((await (await api('GET', `/repos/${USER}/${REPO}/issues/${String(target.number)}/reactions`)).json() as unknown[] | null) ?? []).length, {timeout: 15_000}).toBe(0);

  // Subscribing (Shift+S), then unsubscribing.
  const checkSub = async () => ((await (await api('GET', `/repos/${USER}/${REPO}/issues/${String(target.number)}/subscriptions/check`)).json()) as {subscribed: boolean}).subscribed;
  const props = page.getByRole('complementary', {name: 'Properties'});
  // The poster is subscribed (Forgejo's rule, without an explicit choice): the sidebar agrees with the server.
  const was = await checkSub();
  expect(was).toBe(true);
  await expect(props.getByText('Subscribed', {exact: true})).toBeVisible();
  await page.locator('body').click({position: {x: 1, y: 1}}).catch(() => undefined);
  await page.keyboard.press('Shift+S');
  await expect(props.getByText('Not subscribed', {exact: true})).toBeVisible();
  await expect.poll(checkSub, {timeout: 15_000}).toBe(false);
  await page.keyboard.press('Shift+S');
  await expect(props.getByText('Subscribed', {exact: true})).toBeVisible();
  await expect.poll(checkSub, {timeout: 15_000}).toBe(true);
  expect(dialogs).toBe(0);
  expect(problems).toEqual([]);
  await ctx.close();
});
