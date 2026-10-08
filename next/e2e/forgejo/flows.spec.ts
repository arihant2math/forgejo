// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The two daily flows end to end, the way a person does them, each checked
// against the server and a second user:
//
//   * triage: the inbox (G N) → the issue a colleague commented on (Enter,
//     which reads the notification) → a label (L) and a priority (P) → the
//     issue's board (its Project link) → the card moved to the next column
//     (Shift+L);
//   * review: "Review requested" in My pull requests → the pull request →
//     Files → a comment on a line → R → Approve; the author sees the
//     approval with the comment on its line, pinned to the head reviewed.

import {expect, type Page, test} from '@playwright/test';
import {api, apiJson, type ApiIssue, b64, newIssue, ok, seed} from '../lib/api.ts';
import {issueTitle, sidebarProp, signedIn, watch} from '../lib/app.ts';
import {aliceAuth, BASE, USER} from '../lib/env.ts';
import {classicColumn, classicProject} from '../lib/projects.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

const RUN = Date.now().toString(36);
const REPO = `flows-${RUN}`;

test.beforeAll(() => {
  test.setTimeout(5 * 60_000);
  seed(REPO, 8);
});

test.afterAll(async () => {
  await api('DELETE', `/repos/${USER}/${REPO}`);
});

async function unreadTitles(): Promise<string[]> {
  return (await apiJson<{subject: {title: string}}[]>('GET', '/notifications?status-types=unread&limit=50')).map((n) => n.subject.title);
}

test('daily triage: inbox → issue → label and priority → its board → card moved', async ({browser}) => {
  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  // An issue dev opened, on a board, that alice comments on: news in dev's inbox.
  const issue = await newIssue(USER, REPO, `Triage me ${RUN}`, 'Something is off.');
  const pid = await classicProject(page, USER, REPO, `Triage board ${RUN}`, [issue]);
  await ok(await api('POST', `/repos/${USER}/${REPO}/issues/${String(issue.number)}/comments`, {body: 'Still happening on main.'}, aliceAuth), 'comment');
  await expect.poll(async () => (await unreadTitles()).includes(issue.title), {timeout: 30_000}).toBe(true);

  // 1. The inbox: G N (from the app), the thread is there, unread.
  await page.goto(`${BASE}/`);
  await expect(page.getByRole('heading', {name: 'Home'})).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('n');
  await expect(page).toHaveURL(`${BASE}/notifications`);
  const inbox = page.getByRole('listbox', {name: 'Notifications'});
  const row = inbox.getByRole('option').filter({hasText: issue.title});
  await expect(row).toBeVisible({timeout: 20_000});
  await expect(row).toContainText('Unread:');
  // 2. J/K to it, Enter opens the issue and reads the notification.
  await inbox.focus();
  const titles = await inbox.getByRole('option').allInnerTexts();
  const at = titles.findIndex((t) => t.includes(issue.title));
  for (let i = 0; i < at; i++) await page.keyboard.press('j');
  await expect(row).toHaveAttribute('data-active', '');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${BASE}/${USER}/${REPO}/issues/${String(issue.number)}`);
  await expect(issueTitle(page)).toContainText(issue.title);
  await expect(page.getByRole('region', {name: 'Activity'})).toContainText('Still happening on main.', {timeout: 15_000});
  await expect.poll(async () => (await unreadTitles()).includes(issue.title), {timeout: 15_000}).toBe(false);

  // 3. Triage: a label (L) and a priority (P), each shown at once.
  await page.keyboard.press('l');
  await page.getByPlaceholder('Add or remove labels…').fill('bug');
  await expect(page.getByRole('option', {name: /^bug\b/})).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(sidebarProp(page, 'Labels')).toContainText('bug');
  await page.keyboard.press('p');
  await page.getByRole('option', {name: /High/}).click();
  await expect(sidebarProp(page, 'Priority')).toContainText('High');
  await expect.poll(async () => (await apiJson<ApiIssue>('GET', `/repos/${USER}/${REPO}/issues/${String(issue.number)}`)).labels.map((l) => l.name).sort(), {timeout: 30_000})
    .toEqual(['bug', 'priority/High']);

  // 4. Its board, from the issue's Project.
  const project = sidebarProp(page, 'Project');
  await expect(project).toContainText(`Triage board ${RUN}`, {timeout: 15_000});
  const from = /· (.+)$/.exec(await project.innerText())?.[1]?.trim() ?? '';
  await project.getByRole('link', {name: `Triage board ${RUN}`}).click();
  await expect(page).toHaveURL(`${BASE}/-/next/projects/${String(pid)}`);
  const columns = await page.locator('section[data-column] h2').allInnerTexts();
  const next = columns[columns.indexOf(from) + 1] ?? '';
  expect(next).not.toBe('');
  const column = (p: Page, name: string) => p.locator('section[data-column]').filter({has: p.getByRole('heading', {name, exact: true})});
  const card = column(page, from).getByRole('option').filter({hasText: issue.title});
  await expect(card).toBeVisible({timeout: 30_000});
  // 5. The card to the next column with the keyboard.
  await column(page, from).getByRole('listbox').focus();
  const cards = await column(page, from).getByRole('option').allInnerTexts();
  for (let i = 0; i < cards.findIndex((t) => t.includes(issue.title)); i++) await page.keyboard.press('j');
  await expect(card).toHaveAttribute('data-active', '');
  await page.keyboard.press('Shift+L');
  await expect(column(page, next).getByRole('option').filter({hasText: issue.title})).toBeVisible();
  // The classic UI (the server) agrees, and the issue page says where it is.
  await expect.poll(() => classicColumn(page, USER, REPO, pid, issue), {timeout: 30_000}).toBe(next);
  await page.goBack();
  await expect(sidebarProp(page, 'Project')).toContainText(next, {timeout: 15_000});
  expect(problems).toEqual([]);
  await ctx.close();
});

function tsFile(n: number, salt = ''): string {
  return `${Array.from({length: n}, (_, i) => `export const v${String(i)}${salt}: number = ${String(i)};`).join('\n')}\n`;
}

test('pull request review: review requested → files → a line comment → R → Approve; the author sees it on its line', async ({browser}) => {
  // alice proposes a change and asks dev to review it.
  await ok(await api('POST', `/repos/${USER}/${REPO}/contents`, {branch: 'main', message: 'Add a file', files: [{operation: 'create', path: 'src/a.ts', content: b64(tsFile(20))}]}), 'base file');
  const sha = (await apiJson<{sha: string}>('GET', `/repos/${USER}/${REPO}/contents/src/a.ts`)).sha;
  await ok(await api('POST', `/repos/${USER}/${REPO}/contents`, {branch: 'main', new_branch: `alice-${RUN}`, message: 'Tweak', files: [
    {operation: 'update', path: 'src/a.ts', sha, content: b64(tsFile(20).replace('v3: number = 3', 'v3: number = 33'))},
  ]}, aliceAuth), 'change');
  const pr = await apiJson<{number: number; head: {sha: string}}>('POST', `/repos/${USER}/${REPO}/pulls`, {head: `alice-${RUN}`, base: 'main', title: `Tweak v3 ${RUN}`}, aliceAuth);
  await ok(await api('POST', `/repos/${USER}/${REPO}/pulls/${String(pr.number)}/requested_reviewers`, {reviewers: [USER]}, aliceAuth), 'request review');

  const ctx = await browser.newContext();
  const page = await signedIn(ctx);
  const problems = watch(page);
  // 1. My pull requests, review requested: it is there.
  await page.goto(`${BASE}/pulls?type=review_requested`);
  await expect(page.getByRole('link', {name: 'Review requested'})).toHaveAttribute('aria-current', 'page');
  const list = page.getByRole('listbox', {name: 'My pull requests'});
  const row = list.getByRole('option').filter({hasText: `Tweak v3 ${RUN}`});
  await expect(row).toBeVisible({timeout: 30_000});
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/${USER}/${REPO}/pulls/${String(pr.number)}`));
  // 2. Files: the changed line.
  await page.getByRole('link', {name: 'Files'}).click();
  const diff = page.getByRole('list', {name: 'Changes'});
  await expect(diff).toBeVisible({timeout: 30_000});
  const line = diff.getByRole('listitem').filter({hasText: 'export const v3: number = 33;'}).first();
  await expect(line).toBeVisible({timeout: 30_000});
  // 3. A comment on that line.
  await line.hover();
  await line.getByRole('button', {name: /^Comment on line \d+$/}).click();
  await page.getByRole('textbox', {name: 'Review comment'}).fill('Why 33 and not 3?');
  await page.getByRole('button', {name: 'Add review comment'}).click();
  await expect(page.getByText('1 pending comment')).toBeVisible();
  // 4. R: the review dialog; Approve; submit.
  await page.locator('body').click({position: {x: 5, y: 5}});
  await page.keyboard.press('r');
  const dialog = page.getByRole('dialog', {name: 'Submit review'});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', {name: 'Review summary'}).fill('Looks good otherwise.');
  await dialog.getByRole('radio', {name: 'Approve'}).click();
  await dialog.getByRole('button', {name: 'Submit review'}).click();
  await expect(dialog).toBeHidden();

  // The author (API v1 as alice) sees one approval on the head reviewed, with the comment on its line.
  interface Review {id: number; user: {login: string}; state: string; body: string; commit_id: string}
  const reviews = () => apiJson<Review[]>('GET', `/repos/${USER}/${REPO}/pulls/${String(pr.number)}/reviews`, undefined, aliceAuth);
  await expect.poll(async () => (await reviews()).filter((r) => r.user.login === USER && r.state === 'APPROVED').length, {timeout: 30_000}).toBe(1);
  const mine = (await reviews()).filter((r) => r.user.login === USER && r.state !== 'REQUEST_REVIEW');
  expect(mine).toHaveLength(1);
  expect(mine[0]?.body).toBe('Looks good otherwise.');
  expect(mine[0]?.commit_id).toBe(pr.head.sha);
  const comments = await apiJson<{path: string; body: string; position: number}[]>('GET', `/repos/${USER}/${REPO}/pulls/${String(pr.number)}/reviews/${String(mine[0]?.id)}/comments`, undefined, aliceAuth);
  expect(comments.map((c) => [c.path, c.body])).toEqual([['src/a.ts', 'Why 33 and not 3?']]);
  // The pending marks are gone once the server has it; the conversation shows the approval.
  await expect(page.getByText('1 pending comment')).toHaveCount(0, {timeout: 30_000});
  await page.getByRole('link', {name: 'Conversation'}).click();
  await expect(page.getByRole('region', {name: 'Activity'})).toContainText('Looks good otherwise.', {timeout: 15_000});
  expect(problems).toEqual([]);
  await ctx.close();
});
