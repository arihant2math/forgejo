// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Code surfaces (F7) against a real Forgejo with livesync and Actions on,
// serving this build:
//
//   * the repository browser: directories, a highlighted file (worker), blame,
//     branches, history, a commit's diff; hostile file names and contents stay text;
//   * a pull request awaiting review is prefetched (diff, files), then read and
//     reviewed offline — a draft comment on a line, the review submitted offline —
//     and the review arrives once, pinned to the commit seen, on reconnect;
//   * viewed files are intents; merge is disabled offline with the reason;
//   * a job's live log streams over the socket (a runner speaking Forgejo's runner
//     protocol uploads lines), and the finished log opens from the cache offline.
//
// Switching to a cached file and the 5 000-line diff's scrolling are timed in perf.spec.ts.
// Results (timings) are attached to the test results and printed.

import {expect, test} from '@playwright/test';
import {api, b64, ensureUser, ok} from '../lib/api.ts';
import {signIn, watch} from '../lib/app.ts';
import {blobSha as blobShaIn, changeFiles, codeUrl, goFile, type Pull, tsFile} from '../lib/code.ts';
import {cachedBlob as cached} from '../lib/device.ts';
import {ALICE, aliceAuth as alice, BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

const RUN = Date.now().toString(36);
const REPO = `f7-${RUN}`;

let reviewPull: Pull;
let repoId = 0;
/** A personal access token of dev (livesync's endpoints take tokens only). */
let token = '';

test.beforeAll(async () => {
  test.setTimeout(5 * 60_000);
  await ensureUser(ALICE.user);
  const repo = await (await ok(await api('POST', '/user/repos', {name: REPO, auto_init: true, default_branch: 'main'}), 'create repo')).json() as {id: number};
  repoId = repo.id;
  token = (await (await ok(await api('POST', `/users/${USER}/tokens`, {name: `f7-${RUN}`, scopes: ['read:repository', 'read:issue', 'read:organization', 'read:user', 'read:notification']}), 'token')).json() as {sha1: string}).sha1;
  await ok(await api('PUT', `/repos/${USER}/${REPO}/collaborators/alice`, {permission: 'write'}), 'collaborator');
  await ok(await api('PATCH', `/repos/${USER}/${REPO}`, {has_actions: true}), 'actions on');
  await changeFiles(REPO, {
    branch: 'main', message: 'Add sources',
    files: [
      {operation: 'create', path: 'src/main.go', content: b64(goFile(80))},
      {operation: 'create', path: 'src/other.go', content: b64(goFile(40))},
      {operation: 'create', path: 'src/third.ts', content: b64(tsFile(200))},
      {operation: 'create', path: 'docs/<img src=x onerror=alert(1)>.md', content: b64('# <script>alert(1)</script>\n<img src=x onerror=alert(2)>\n')},
      {operation: 'create', path: 'docs/a b.txt', content: b64('spaces in the name\n')},
    ],
  });
  // A small pull request by alice that requests dev's review.
  await changeFiles(REPO, {branch: 'main', new_branch: 'small', message: 'Small change', files: [
    {operation: 'update', path: 'src/other.go', content: b64(goFile(40).replace('"value", 3)', '"value is", 3)')), sha: await blobSha('src/other.go')},
    {operation: 'create', path: 'src/new.ts', content: b64(tsFile(30))},
  ]}, alice);
  reviewPull = await (await ok(await api('POST', `/repos/${USER}/${REPO}/pulls`, {head: 'small', base: 'main', title: 'A small change', body: 'Please review'}, alice), 'small pull')).json() as Pull;
  await ok(await api('POST', `/repos/${USER}/${REPO}/pulls/${String(reviewPull.number)}/requested_reviewers`, {reviewers: [USER]}, alice), 'review request');
});

// A repository per run: removed afterwards (the workspace sidebar lists a few repositories per owner, and
// leftovers would push other suites' repositories out of it).
test.afterAll(async () => {
  await api('DELETE', `/repos/${USER}/${REPO}`);
  await api('DELETE', `/users/${USER}/tokens/f7-${RUN}`);
});

const blobSha = (path: string, ref?: string) => blobShaIn(REPO, path, ref);
const code = (rest: string) => codeUrl(REPO, rest);

test('repository browser: tree, highlighted file, blame, branches, history, commit; hostile names stay text', async ({page}) => {
  const problems = watch(page);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    // The classic login pages warn that their (unbuilt, in this sandbox) assets are missing: not ours.
    if (!d.message().startsWith('Failed to load asset files')) dialogs.push(`${d.type()}: ${d.message()} @ ${page.url()}`);
    void d.dismiss();
  });
  await signIn(page);
  await page.goto(code('src'));
  const files = page.getByRole('listbox', {name: 'Files'});
  await expect(files.getByRole('option', {name: /^src/})).toBeVisible({timeout: 20_000});
  await expect(files.getByRole('option', {name: /<img src=x onerror=alert\(1\)>\.md|docs/}).first()).toBeVisible();
  await files.getByRole('option', {name: /^src/}).click();
  await page.getByRole('listbox', {name: 'Files'}).getByRole('option', {name: /^main\.go/}).click();
  await expect(page.getByRole('list', {name: /src\/main\.go, \d+ lines/})).toBeVisible();
  // Highlighted in the worker: keyword spans (classes only, no HTML from the file).
  await expect(page.locator('.text-syn-keyword').first()).toBeVisible({timeout: 15_000});
  await expect(page.locator('.text-syn-keyword').first()).toHaveText(/package|import|func/);
  // Blame.
  await page.getByRole('link', {name: 'Blame'}).click();
  await expect(page.getByRole('list', {name: 'Blame of src/main.go'})).toBeVisible({timeout: 15_000});
  await expect(page.getByText('Add sources').first()).toBeVisible();
  // Hostile file name and content: text.
  await page.goto(code('src/branch/main/docs'));
  await page.getByRole('option', {name: /onerror/}).click();
  // A markdown file opens rendered (scrubbed: no script, no event handler); its source is text.
  await expect(page.getByRole('radio', {name: 'Preview'})).toBeVisible({timeout: 15_000});
  expect(await page.locator('main script, main [onerror]').count()).toBe(0);
  await page.getByRole('radio', {name: 'Source'}).click();
  await expect(page.getByText('<img src=x onerror=alert(2)>')).toBeVisible({timeout: 15_000});
  expect(await page.locator('main img').count()).toBe(0);
  // A name with a space.
  await page.goto(code('src/branch/main/docs/a b.txt'));
  await expect(page.getByText('spaces in the name')).toBeVisible({timeout: 15_000});
  // Branches (from the pool), history and a commit with its diff.
  await page.getByRole('link', {name: 'Branches'}).click();
  await expect(page.getByRole('option', {name: /^small/})).toBeVisible();
  await expect(page.getByRole('option', {name: /^main.*default/})).toBeVisible();
  await page.getByRole('link', {name: 'Commits'}).click();
  await page.getByRole('option', {name: /Add sources/}).click();
  await expect(page.getByRole('list', {name: 'Changes'})).toBeVisible({timeout: 15_000});
  await expect(page.getByText('src/main.go').first()).toBeVisible();
  expect(dialogs).toEqual([]);
  expect(problems).toEqual([]);
});

test('a pull request awaiting review is prefetched, reviewed offline, and the review submits on reconnect', async ({page, context}, info) => {
  test.setTimeout(240_000);
  const problems = watch(page);
  await signIn(page);
  // The prefetch runs when the page is idle (15 s after the shell, at most every 15 min per user): make it due.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('forgejo-next:prefetch:')) localStorage.removeItem(k);
  });
  await page.reload();
  const t0 = Date.now();
  await expect.poll(() => cached(page, `diff:${String(repoId)}:${reviewPull.merge_base}:${reviewPull.head.sha}`), {timeout: 90_000, intervals: [1000]}).toBe(true);
  // The head's files, by blob SHA (what the file view reads).
  const newTs = await blobSha('src/new.ts', reviewPull.head.sha);
  await expect.poll(() => cached(page, `blob:${String(repoId)}:${newTs}`), {timeout: 30_000}).toBe(true);
  console.log(`prefetched after ${String(Date.now() - t0)} ms`);
  // The service worker serves the app offline.
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active && navigator.serviceWorker.controller)), {timeout: 30_000}).toBe(true);

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.goto(`${BASE}/${USER}/${REPO}/pulls/${String(reviewPull.number)}?tab=files`);
  const list = page.getByRole('list', {name: 'Changes'});
  await expect(list).toBeVisible({timeout: 30_000});
  await expect(page.getByText('src/new.ts').first()).toBeVisible();
  // Merge is online only: disabled offline, with the reason.
  await page.getByRole('link', {name: 'Conversation'}).click();
  await expect(page.getByRole('button', {name: 'Merge…', exact: true})).toBeDisabled();
  await expect(page.getByText('Merging needs a connection: it is not queued offline.')).toBeVisible();
  await page.getByRole('link', {name: 'Files'}).click();
  await expect(list).toBeVisible();
  // A draft comment on an added line of new.ts (new side, line 3).
  const row = list.getByRole('listitem').filter({hasText: 'export const value2: number'}).first();
  await row.hover();
  await row.getByRole('button', {name: 'Comment on line 3'}).click();
  await page.getByRole('textbox', {name: 'Review comment'}).fill('Offline nit: name this better.');
  await page.getByRole('button', {name: 'Start a review'}).click();
  await expect(page.getByText('Offline nit: name this better.')).toBeVisible();
  await expect(page.getByText('1 pending comment')).toBeVisible();
  // R: submit the review offline.
  await page.locator('body').click({position: {x: 5, y: 5}});
  await page.keyboard.press('r');
  const dialog = page.getByRole('dialog', {name: 'Submit review'});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', {name: 'Review summary'}).fill('Reviewed on the train.');
  await dialog.getByRole('button', {name: 'Submit review'}).click();
  await expect(page.getByText('Review queued')).toBeVisible();
  // Viewed (an intent too).
  await page.getByRole('button', {name: 'Viewed'}).first().click();
  const before = await (await api('GET', `/repos/${USER}/${REPO}/pulls/${String(reviewPull.number)}/reviews`)).json() as {state: string}[];
  expect(before.filter((r) => r.state !== 'REQUEST_REVIEW')).toEqual([]);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => {
    const all = await (await api('GET', `/repos/${USER}/${REPO}/pulls/${String(reviewPull.number)}/reviews`)).json() as {id: number; user: {login: string}; body: string; commit_id: string; state: string}[];
    return all.filter((r) => r.user.login === USER && r.state !== 'REQUEST_REVIEW');
  }, {timeout: 60_000}).toHaveLength(1);
  const all = await (await api('GET', `/repos/${USER}/${REPO}/pulls/${String(reviewPull.number)}/reviews`)).json() as {id: number; user: {login: string}; body: string; commit_id: string; state: string}[];
  const mine = all.filter((r) => r.user.login === USER && r.state !== 'REQUEST_REVIEW');
  expect(mine).toHaveLength(1);
  expect(mine[0]?.body).toBe('Reviewed on the train.');
  expect(mine[0]?.commit_id).toBe(reviewPull.head.sha);
  const comments = await (await api('GET', `/repos/${USER}/${REPO}/pulls/${String(reviewPull.number)}/reviews/${String(mine[0]?.id)}/comments`)).json() as {path: string; body: string; position: number; original_position: number}[];
  expect(comments.map((c) => [c.path, c.body])).toEqual([['src/new.ts', 'Offline nit: name this better.']]);
  // Viewed files reached the server too (B9).
  // B9 takes the issue's id (a pull request's own id differs from it).
  const issue = await (await ok(await api('GET', `/repos/${USER}/${REPO}/issues/${String(reviewPull.number)}`), 'issue')).json() as {id: number};
  await expect.poll(async () => {
    const v = await (await fetch(`${BASE}/-/sync/api/issues/${String(issue.id)}/viewed`, {headers: {Authorization: `token ${token}`}})).json() as {files?: Record<string, string>};
    return Object.values(v.files ?? {}).filter((s) => s === 'viewed').length;
  }, {timeout: 30_000}).toBeGreaterThan(0);
  await info.attach('offline-review.json', {body: JSON.stringify({review: mine[0], comments}), contentType: 'application/json'});
  expect(problems.filter((p) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|net::/.test(p))).toEqual([]);
});

/** A runner talking Forgejo's runner protocol (connect-go, JSON), as conformance/5-logtail does. */
class Runner {
  private readonly uuid: string;
  private readonly token: string;

  constructor(uuid: string, token: string) {
    this.uuid = uuid;
    this.token = token;
  }

  async call<T>(method: string, body: unknown): Promise<T> {
    const res = await fetch(`${BASE}/api/actions/runner.v1.RunnerService/${method}`, {
      method: 'POST', headers: {'Content-Type': 'application/json', 'x-runner-uuid': this.uuid, 'x-runner-token': this.token}, body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`runner ${method}: ${String(res.status)} ${text}`);
    return JSON.parse(text) as T;
  }

  log(taskId: number, index: number, lines: string[], noMore = false): Promise<unknown> {
    const now = new Date().toISOString();
    return this.call('UpdateLog', {taskId: String(taskId), index: String(index), rows: lines.map((content) => ({time: now, content})), noMore});
  }
}

test('a job log streams live over the socket; the finished log opens offline', async ({page, context}, info) => {
  test.setTimeout(240_000);
  const problems = watch(page);
  const label = `f7-${RUN}`;
  const reg = await (await ok(await api('POST', `/repos/${USER}/${REPO}/actions/runners`, {name: label}), 'runner')).json() as {uuid: string; token: string};
  const runner = new Runner(reg.uuid, reg.token);
  await runner.call('Declare', {version: 'f7', labels: [label]});
  await signIn(page);
  await changeFiles(REPO, {branch: 'main', message: 'CI', files: [{operation: 'create', path: '.forgejo/workflows/ci.yml', content: b64(`on: [push]\njobs:\n  build:\n    runs-on: ${label}\n    steps:\n      - run: echo hello\n`)}]});
  let taskId = 0;
  await expect.poll(async () => {
    const r = await runner.call<{task?: {id: string}}>('FetchTask', {tasksVersion: '0'});
    if (r.task) taskId = Number(r.task.id);
    return taskId;
  }, {timeout: 60_000, intervals: [1000]}).toBeGreaterThan(0);
  await page.goto(code('actions'));
  await page.getByRole('option', {name: /CI/}).first().click();
  const log = page.getByRole('list', {name: 'Log of build'});
  await expect(page.getByRole('navigation', {name: 'Jobs'}).getByText('build')).toBeVisible({timeout: 20_000});
  // Lines uploaded by the runner appear without a reload (B9 log tail through the leader's socket).
  const t0 = Date.now();
  await runner.log(taskId, 0, ['\x1b[32mstep one ok\x1b[0m', 'second line']);
  await expect(log.getByText('step one ok')).toBeVisible({timeout: 15_000});
  const first = Date.now() - t0;
  await expect(log.getByText('step one ok')).toHaveClass(/text-success/);
  await runner.log(taskId, 2, ['third line <script>alert(1)</script>']);
  await expect(log.getByText('third line <script>alert(1)</script>')).toBeVisible({timeout: 15_000});
  await runner.call('UpdateTask', {state: {id: String(taskId), result: 'RESULT_SUCCESS', stoppedAt: new Date().toISOString()}});
  await runner.log(taskId, 3, ['last line'], true);
  await expect(log.getByText('last line')).toBeVisible({timeout: 15_000});
  console.log(`live log: first lines on screen ${String(first)} ms after the upload`);
  await info.attach('log-tail.json', {body: JSON.stringify({firstLinesMs: first}), contentType: 'application/json'});
  // Finished: the job's status arrives, the log is cached by (job, task); offline it opens from the cache.
  await expect(page.getByRole('navigation', {name: 'Jobs'}).getByText('Succeeded')).toBeVisible({timeout: 30_000});
  await expect.poll(() => cached(page, `log:${String(repoId)}:`), {timeout: 15_000}).toBe(true);
  const url = page.url();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.goto(url);
  await expect(page.getByRole('list', {name: 'Log of build'}).getByText('last line')).toBeVisible({timeout: 20_000});
  await context.setOffline(false);
  expect(problems.filter((p) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|net::/.test(p))).toEqual([]);
});
