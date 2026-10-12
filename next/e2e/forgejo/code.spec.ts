// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {expect, type Locator, test} from '@playwright/test';
import {api, b64, ensureUser, ok} from '../lib/api.ts';
import {signIn, watch} from '../lib/app.ts';
import {blobSha as blobShaIn, changeFiles, codeUrl, commentOnLine, goFile, type Pull, tsFile} from '../lib/code.ts';
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
  await changeFiles(REPO, {branch: 'main', new_branch: 'small', message: 'Small change', files: [
    {operation: 'update', path: 'src/other.go', content: b64(goFile(40).replace('"value", 3)', '"value is", 3)')), sha: await blobSha('src/other.go')},
    {operation: 'create', path: 'src/new.ts', content: b64(tsFile(30))},
  ]}, alice);
  reviewPull = await (await ok(await api('POST', `/repos/${USER}/${REPO}/pulls`, {head: 'small', base: 'main', title: 'A small change', body: 'Please review'}, alice), 'small pull')).json() as Pull;
  await ok(await api('POST', `/repos/${USER}/${REPO}/pulls/${String(reviewPull.number)}/requested_reviewers`, {reviewers: [USER]}, alice), 'review request');
});

// Remove per-run repositories so leftovers cannot displace other suites' sidebar entries.
test.afterAll(async () => {
  await api('DELETE', `/repos/${USER}/${REPO}`);
  await api('DELETE', `/users/${USER}/tokens/f7-${RUN}`);
});

test('copy a selected range permalink and pin source and blame with Y', async ({page}) => {
  await signIn(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {value: {writeText: (text: string) => {
      document.documentElement.dataset.copiedLink = text;
      return Promise.resolve();
    }}});
  });
  await page.goto(code('src/branch/main/src/main.go'));
  await page.getByRole('link', {name: 'Line 12', exact: true}).click();
  await page.getByRole('link', {name: 'Line 20', exact: true}).click({modifiers: ['Shift']});
  await expect(page).toHaveURL(/#L12-L20$/);
  await page.getByRole('button', {name: 'File actions'}).click();
  await page.getByRole('menuitem', {name: 'Copy permalink', exact: true}).click();
  await expect(page.getByText('Link copied', {exact: true})).toBeVisible();
  const copied = await page.locator('html').getAttribute('data-copied-link');
  expect(copied).toMatch(/\/src\/commit\/[a-f0-9]{40}\/src\/main\.go#L12-L20$/);
  const sha = /\/commit\/([a-f0-9]{40})\//.exec(copied ?? '')?.[1];
  await page.keyboard.press('y');
  await expect(page).toHaveURL(new RegExp(`/src/commit/${sha}/src/main.go#L12-L20$`));
  await page.goto(copied ?? '');
  await expect(page).toHaveURL(copied ?? '');
  await page.goto(`${code(`src/commit/${sha}/src/main.go`)}#L12-L20`);
  await expect(page.getByRole('link', {name: 'Line 12', exact: true})).toHaveAttribute('data-selected-line', 'first');
  await expect(page.getByRole('link', {name: 'Line 20', exact: true})).toHaveAttribute('data-selected-line', 'last');
  await page.goto(`${code('blame/branch/main/src/main.go')}#L12-L20`);
  await expect(page.getByRole('button', {name: 'Line actions'})).toBeVisible();
  await page.keyboard.press('y');
  await expect(page).toHaveURL(new RegExp(`/blame/commit/${sha}/src/main.go#L12-L20$`));
});

const blobSha = (path: string, ref?: string) => blobShaIn(REPO, path, ref);
const code = (rest: string) => codeUrl(REPO, rest);

test('repository browser: tree, highlighted file, blame, branches, history, commit; hostile names stay text', async ({page}) => {
  const problems = watch(page);
  const dialogs: string[] = [];
  page.on('dialog', (d) => {
    // Ignore classic login warnings about sandbox assets; they are not app errors.
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
  await expect(page.getByRole('region', {name: /src\/main\.go, \d+ lines/})).toBeVisible();
  const below = async (a: Locator, b: Locator) => ((await a.boundingBox())?.y ?? 0) >= ((await b.boundingBox())?.y ?? Infinity) + 1;
  const crumbs = page.getByRole('navigation', {name: 'Breadcrumb'});
  const repoTabs = page.getByRole('navigation', {name: 'Repository'});
  expect(await below(repoTabs, crumbs)).toBe(true);
  expect(await below(page.getByRole('button', {name: 'Ref: main'}), repoTabs)).toBe(true);
  // Pierre colours tokens with inline theme styles inside its Shadow DOM.
  await expect(page.locator('[data-line] span[style*="prettylights"]').first()).toBeVisible({timeout: 15_000});
  await expect(page.locator('[data-line] span[style*="prettylights"]').first()).toHaveText(/package|import|func/);
  await page.getByRole('button', {name: 'Blame', exact: true}).click();
  await expect(page.getByRole('list', {name: 'Blame of src/main.go'})).toBeVisible({timeout: 15_000});
  await expect(page.getByText('Add sources').first()).toBeVisible();
  await expect(page.getByRole('list', {name: 'Blame of src/main.go'}).locator('.text-syntax-keyword').first()).toBeVisible();
  await page.goto(code('src/branch/main/docs'));
  await page.getByRole('option', {name: /onerror/}).click();
  await expect(page.getByRole('button', {name: 'Preview', exact: true})).toBeVisible({timeout: 15_000});
  expect(await page.locator('main script, main [onerror]').count()).toBe(0);
  await page.getByRole('button', {name: 'Code', exact: true}).click();
  await expect(page.getByText('<img src=x onerror=alert(2)>')).toBeVisible({timeout: 15_000});
  expect(await page.locator('main img').count()).toBe(0);
  await page.goto(code('src/branch/main/docs/a b.txt'));
  await expect(page.getByText('spaces in the name')).toBeVisible({timeout: 15_000});
  await page.goto(`${BASE}/${USER}/${REPO}`);
  const tabs = page.getByRole('navigation', {name: 'Repository'});
  await expect(tabs.getByRole('link', {name: 'Code'})).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', {name: 'Ref: main'}).click();
  await page.getByRole('option', {name: /^small/}).click();
  await expect(page).toHaveURL(/\/src\/branch\/small$/);
  await expect(tabs.getByRole('link', {name: 'Code'})).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await page.getByRole('link', {name: /^\d+ branches$/}).click();
  await expect(page.getByRole('option', {name: /^small/})).toBeVisible();
  await expect(page.getByRole('option', {name: /^main.*default/})).toBeVisible();
  await page.goBack();
  await page.getByRole('link', {name: 'History', exact: true}).click();
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
  // Clear the idle prefetch timestamp to make the review due.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) if (k.startsWith('forgejo-next:prefetch:')) localStorage.removeItem(k);
  });
  await page.reload();
  const t0 = Date.now();
  await expect.poll(() => cached(page, `diff:${String(repoId)}:${reviewPull.merge_base}:${reviewPull.head.sha}`), {timeout: 90_000, intervals: [1000]}).toBe(true);
  const newTs = await blobSha('src/new.ts', reviewPull.head.sha);
  await expect.poll(() => cached(page, `blob:${String(repoId)}:${newTs}`), {timeout: 30_000}).toBe(true);
  console.log(`prefetched after ${String(Date.now() - t0)} ms`);
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.active && navigator.serviceWorker.controller)), {timeout: 30_000}).toBe(true);

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.goto(`${BASE}/${USER}/${REPO}/pulls/${String(reviewPull.number)}?tab=files`);
  const list = page.getByRole('list', {name: 'Changes'});
  await expect(list).toBeVisible({timeout: 30_000});
  await expect(page.getByText('src/new.ts').first()).toBeVisible();
  await page.getByRole('link', {name: 'Conversation'}).click();
  await expect(page.getByRole('button', {name: 'Merge pull request', exact: true})).toBeDisabled();
  await expect(page.getByText('Merging needs a connection: it is not queued offline.')).toBeVisible();
  await page.getByRole('link', {name: 'Files changed'}).click();
  await expect(list).toBeVisible();
  await commentOnLine(page, 'export const value2: number', 'Comment on line 3');
  await page.getByRole('textbox', {name: 'Review comment'}).fill('Offline nit: name this better.');
  await page.getByRole('button', {name: 'Start a review'}).click();
  await expect(page.getByText('Offline nit: name this better.')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Submit review (1 pending comment)'})).toBeVisible();
  await page.locator('body').click({position: {x: 5, y: 5}});
  await page.keyboard.press('r');
  const dialog = page.getByRole('dialog', {name: 'Submit review'});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', {name: 'Review summary'}).fill('Reviewed on the train.');
  await dialog.getByRole('button', {name: 'Submit review'}).click();
  await expect(page.getByText('Review queued')).toBeVisible();
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
  // Viewed-file endpoints require the issue ID, not the pull request ID.
  const issue = await (await ok(await api('GET', `/repos/${USER}/${REPO}/issues/${String(reviewPull.number)}`), 'issue')).json() as {id: number};
  await expect.poll(async () => {
    const v = await (await fetch(`${BASE}/-/sync/api/issues/${String(issue.id)}/viewed`, {headers: {Authorization: `token ${token}`}})).json() as {files?: Record<string, string>};
    return Object.values(v.files ?? {}).filter((s) => s === 'viewed').length;
  }, {timeout: 30_000}).toBeGreaterThan(0);
  const reviewComments = `/repos/${USER}/${REPO}/pulls/${String(reviewPull.number)}/reviews/${String(mine[0]?.id)}/comments`;
  const posted = page.getByRole('article').filter({hasText: 'Offline nit: name this better.'}).last();
  await expect(posted).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await posted.getByRole('button', {name: 'Comment actions'}).click();
  await page.getByRole('menuitem', {name: 'Edit', exact: true}).click();
  await posted.locator('.cm-content').fill('Corrected offline nit.');
  await posted.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(posted).toHaveCount(0);
  await expect(page.getByText('Corrected offline nit.', {exact: true})).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await (await api('GET', reviewComments)).json() as {body: string}[]).map((c) => c.body), {timeout: 30_000}).toEqual(['Corrected offline nit.']);
  await page.goto(`${BASE}/${USER}/${REPO}/pulls/${String(reviewPull.number)}`);
  const corrected = page.getByRole('article').filter({hasText: 'Corrected offline nit.'}).last();
  await expect(corrected).toBeVisible();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await corrected.getByRole('button', {name: 'Comment actions'}).click();
  await page.getByRole('menuitem', {name: 'Delete…'}).click();
  await page.getByRole('dialog', {name: 'Delete this comment?'}).getByRole('button', {name: 'Delete', exact: true}).click();
  await expect(page.getByText('Corrected offline nit.', {exact: true})).toHaveCount(0);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await (await api('GET', reviewComments)).json() as unknown[]).length, {timeout: 30_000}).toBe(0);
  await info.attach('offline-review.json', {body: JSON.stringify({review: mine[0], comments}), contentType: 'application/json'});
  expect(problems.filter((p) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|net::/.test(p))).toEqual([]);
});

/** Runner protocol client (connect-go, JSON). */
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
  let taskContext: {token: string; run_id: string} | undefined;
  await expect.poll(async () => {
    const r = await runner.call<{task?: {id: string; context: {token: string; run_id: string}}}>('FetchTask', {tasksVersion: '0'});
    if (r.task) {
      taskId = Number(r.task.id);
      taskContext = r.task.context;
    }
    return taskId;
  }, {timeout: 60_000, intervals: [1000]}).toBeGreaterThan(0);
  // The artifact upload requires a task token that is still valid.
  if (!taskContext) throw new Error('Runner did not receive a task context');
  const artifactPath = `/api/actions_pipeline/_apis/pipelines/workflows/${taskContext.run_id}/artifacts`;
  const headers = {Authorization: `Bearer ${taskContext.token}`};
  const created = await ok(await fetch(`${BASE}${artifactPath}`, {method: 'POST', headers: {...headers, 'Content-Type': 'application/json'}, body: JSON.stringify({Type: 'actions_storage', Name: 'build-output'})}), 'create artifact');
  const upload = await created.json() as {fileContainerResourceUrl: string};
  await ok(await fetch(`${upload.fileContainerResourceUrl}?itemPath=build-output/output.txt`, {method: 'PUT', headers: {...headers, 'Content-Range': 'bytes 0-4/5', 'x-tfs-filelength': '5'}, body: 'hello'}), 'upload artifact');
  await ok(await fetch(`${BASE}${artifactPath}?artifactName=build-output`, {method: 'PATCH', headers}), 'confirm artifact');
  await page.goto(code('actions'));
  await page.getByRole('option', {name: /CI/}).first().click();
  const log = page.getByRole('list', {name: 'Log of build'});
  await expect(page.getByRole('navigation', {name: 'Jobs'}).getByText('build')).toBeVisible({timeout: 20_000});
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
  await expect(page.getByRole('navigation', {name: 'Jobs'}).getByRole('link', {name: /build, Succeeded/})).toBeVisible({timeout: 30_000});
  const artifacts = page.getByRole('region', {name: 'Artifacts'});
  await artifacts.scrollIntoViewIfNeeded();
  await expect(artifacts.getByText('build-output', {exact: true})).toBeVisible({timeout: 30_000});
  const downloaded = page.waitForEvent('download');
  await artifacts.getByRole('button', {name: 'build-output', exact: true}).click();
  const archive = await downloaded;
  expect(archive.suggestedFilename()).toBe('build-output.zip');
  expect(await archive.failure()).toBeNull();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(artifacts.getByRole('button', {name: 'build-output', exact: true})).toBeDisabled();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await artifacts.getByRole('button', {name: 'Delete build-output', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: 'Delete artifact', exact: true}).click();
  await expect(artifacts.getByText('build-output', {exact: true})).toHaveCount(0);
  await expect.poll(() => cached(page, `log:${String(repoId)}:`), {timeout: 15_000}).toBe(true);
  const url = page.url();
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.goto(url);
  await expect(page.getByRole('list', {name: 'Log of build'}).getByText('last line')).toBeVisible({timeout: 20_000});
  await context.setOffline(false);
  expect(problems.filter((p) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|net::/.test(p))).toEqual([]);
});
