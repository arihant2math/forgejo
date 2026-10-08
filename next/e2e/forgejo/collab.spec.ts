// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Several tabs and several users (PLAN §9): the leader tab hands the
// socket over when it closes and the follower keeps syncing and flushing;
// a collaborator removed mid-session loses the repository on her device
// (group purged, nothing of it left in IndexedDB) and her queued changes to
// it become drafts in "Unsynced changes" instead of being lost or sent; and
// one removed while live loses it at once in every tab.
// (Sign-out across tabs: session.spec.ts; a leader closing mid-flush:
// offline.spec.ts.)

import {expect, type Page, test} from '@playwright/test';
import {api, apiJson, type ApiIssue, newIssue, ok, seed} from '../lib/api.ts';
import {indicator, issueList, issueTitle, sidebar, sidebarProp, signedIn, toggleLabel, watch} from '../lib/app.ts';
import {goOffline, goOnline, storedGroup, storedRecords} from '../lib/device.ts';
import {ALICE, aliceAuth, BASE, USER} from '../lib/env.ts';

test.skip(!BASE, 'NEXT_FORGEJO_URL is not set');
test.describe.configure({mode: 'serial'});

const RUN = Date.now().toString(36);
const REPO = `collab-${RUN}`;
let repoId = 0;

test.beforeAll(async () => {
  test.setTimeout(5 * 60_000);
  seed(REPO, 6);
  repoId = (await apiJson<{id: number}>('GET', `/repos/${USER}/${REPO}`)).id;
});

// A repository per run, removed afterwards (the sidebar lists a few repositories per owner).
test.afterAll(async () => {
  await api('DELETE', `/repos/${USER}/${REPO}`);
});

/** Counts the sync sockets a page opens (only the leader tab of a browser has one). */
function sockets(page: Page): {open: () => number} {
  let open = 0;
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/-/sync/')) return;
    open++;
    ws.on('close', () => {
      open--;
    });
  });
  return {open: () => open};
}

test('leader handoff: the follower tab takes the socket when the leader closes, keeps receiving deltas and sends its edits', async ({browser}) => {
  const target = await newIssue(USER, REPO, `Handoff ${RUN}`);
  const ctx = await browser.newContext();
  const leader = await signedIn(ctx);
  const problems = watch(leader);
  const lSockets = sockets(leader);
  const path = `${BASE}/${USER}/${REPO}/issues/${String(target.number)}`;
  await leader.goto(path);
  await expect(issueTitle(leader)).toContainText(target.title, {timeout: 20_000});
  await expect.poll(() => lSockets.open(), {timeout: 20_000}).toBe(1);
  const follower = await ctx.newPage();
  const followerProblems = watch(follower);
  const fSockets = sockets(follower);
  await follower.goto(path);
  await expect(issueTitle(follower)).toContainText(target.title, {timeout: 20_000});
  // A change by another user reaches the follower through the leader: the browser's one socket (the
  // follower mirrors through the BroadcastChannel and IndexedDB, it has none of its own).
  const renamed = `Renamed by alice ${RUN}`;
  await ok(await api('PATCH', `/repos/${USER}/${REPO}/issues/${String(target.number)}`, {title: renamed}, aliceAuth), 'rename');
  await expect(issueTitle(follower)).toContainText(renamed, {timeout: 15_000});
  expect(fSockets.open()).toBe(0);
  expect(lSockets.open()).toBe(1);

  // The leader goes away, and a change lands while nobody leads (the window a lost announcement would
  // hide): the follower takes the lock, opens its own socket, catches up and is live.
  await leader.close();
  const again = `Renamed again ${RUN}`;
  await ok(await api('PATCH', `/repos/${USER}/${REPO}/issues/${String(target.number)}`, {title: again}, aliceAuth), 'rename');
  await expect.poll(() => fSockets.open(), {timeout: 30_000}).toBe(1);
  await expect(indicator(follower)).toContainText('Live', {timeout: 30_000});
  await expect(issueTitle(follower)).toContainText(again, {timeout: 15_000});
  const third = `Renamed a third time ${RUN}`;
  await ok(await api('PATCH', `/repos/${USER}/${REPO}/issues/${String(target.number)}`, {title: third}, aliceAuth), 'rename');
  await expect(issueTitle(follower)).toContainText(third, {timeout: 15_000});
  // Its own edit is sent by itself now.
  await toggleLabel(follower, 'docs');
  await expect.poll(async () => (await apiJson<ApiIssue>('GET', `/repos/${USER}/${REPO}/issues/${String(target.number)}`)).labels.map((l) => l.name), {timeout: 30_000}).toContain('docs');
  await expect(indicator(follower)).not.toContainText('pending', {timeout: 30_000});
  expect([...problems, ...followerProblems]).toEqual([]);
  await ctx.close();
});

test('a collaborator removed mid-session: the repository is purged from her device and her queued change becomes a draft', async ({browser}) => {
  // alice collaborates on dev's private repository (seed-issues makes her a writer).
  await ok(await api('PATCH', `/repos/${USER}/${REPO}`, {private: true}), 'private');
  const target = await newIssue(USER, REPO, `Revoked ${RUN}`);
  const ctx = await browser.newContext();
  const page = await signedIn(ctx, ALICE);
  const problems = watch(page);
  await page.goto(`${BASE}/${USER}/${REPO}/issues`);
  await expect(issueList(page).getByRole('option').filter({hasText: target.title})).toBeVisible({timeout: 30_000});
  await expect(sidebar(page).getByRole('link', {name: REPO})).toBeVisible();
  // The repository is on her device (stored, not only on screen).
  await expect.poll(() => storedGroup(page, `repo:${String(repoId)}`), {timeout: 30_000}).toBe(true);
  expect(await storedRecords(page, 'Issue', `repo:${String(repoId)}`)).toBeGreaterThan(0);

  // Offline, she labels the issue: queued.
  await page.goto(`${BASE}/${USER}/${REPO}/issues/${String(target.number)}`);
  await expect(issueTitle(page)).toContainText(target.title);
  await goOffline(ctx, page);
  await toggleLabel(page, 'security');
  await expect(sidebarProp(page, 'Labels')).toContainText('security');
  await expect(indicator(page)).toContainText('1 pending');

  // Meanwhile dev removes her from the repository.
  await ok(await api('DELETE', `/repos/${USER}/${REPO}/collaborators/${ALICE.user}`), 'remove collaborator');

  // Back online: the server no longer grants the group; the client purges it and keeps her change as a
  // draft — without sending it (a refused send would end in the drafts too, so the requests are counted).
  const sent: string[] = [];
  page.on('request', (r) => {
    if (/\/issues\/\d+\/labels/.test(r.url())) sent.push(r.url());
  });
  await goOnline(ctx, page);
  await expect(sidebar(page).getByRole('link', {name: REPO})).toHaveCount(0, {timeout: 30_000});
  await expect.poll(() => storedGroup(page, `repo:${String(repoId)}`), {timeout: 30_000}).toBe(false);
  expect(await storedRecords(page, 'Issue', `repo:${String(repoId)}`)).toBe(0);
  // The page no longer shows the issue (it is not on this device any more).
  await expect(page.getByRole('main').getByText(target.title)).toHaveCount(0, {timeout: 15_000});
  // Nothing was sent: the server's issue has no such label, and the change waits in "Unsynced changes".
  expect((await apiJson<ApiIssue>('GET', `/repos/${USER}/${REPO}/issues/${String(target.number)}`)).labels.map((l) => l.name)).not.toContain('security');
  await expect(indicator(page)).toContainText('1 pending', {timeout: 15_000});
  await indicator(page).click();
  const panel = page.getByRole('dialog', {name: 'Unsynced changes'});
  const notSent = panel.getByRole('region', {name: 'Not sent'});
  await expect(notSent).toContainText('Adding the label “security”');
  await expect(notSent).toContainText('You no longer have access to this.');
  expect(sent).toEqual([]);
  // The draft can be discarded (nothing lost silently: it was the user's choice).
  await notSent.getByRole('button', {name: 'Discard', exact: true}).first().click();
  await expect(panel.getByText('Everything is synced')).toBeVisible({timeout: 10_000});
  expect(problems.filter((p) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|net::/.test(p))).toEqual([]);
  await ctx.close();
  await ok(await api('PUT', `/repos/${USER}/${REPO}/collaborators/${ALICE.user}`, {permission: 'write'}), 'add collaborator back');
});

test('access removed while she is live: both of her tabs purge the repository at once, no reload', async ({browser}) => {
  // (The repository is private since the test above; alice is a collaborator again.)
  const target = await newIssue(USER, REPO, `Live revoke ${RUN}`);
  const ctx = await browser.newContext();
  const page = await signedIn(ctx, ALICE);
  const problems = watch(page);
  await page.goto(`${BASE}/${USER}/${REPO}/issues`);
  await expect(issueList(page).getByRole('option').filter({hasText: target.title})).toBeVisible({timeout: 30_000});
  const other = await ctx.newPage();
  await other.goto(`${BASE}/${USER}/${REPO}/issues/${String(target.number)}`);
  await expect(issueTitle(other)).toContainText(target.title, {timeout: 30_000});
  await expect.poll(() => storedGroup(page, `repo:${String(repoId)}`), {timeout: 30_000}).toBe(true);
  await expect(indicator(page)).toContainText('Live');

  await ok(await api('DELETE', `/repos/${USER}/${REPO}/collaborators/${ALICE.user}`), 'remove collaborator');
  // group_revoked on the open socket: the list empties, the issue page leaves the issue, the sidebar
  // forgets the repository, IndexedDB drops the group — in both tabs, live.
  for (const p of [page, other]) {
    await expect(sidebar(p).getByRole('link', {name: REPO})).toHaveCount(0, {timeout: 30_000});
    await expect(p.getByRole('main').getByText(target.title)).toHaveCount(0, {timeout: 15_000});
  }
  await expect.poll(() => storedGroup(page, `repo:${String(repoId)}`), {timeout: 30_000}).toBe(false);
  expect(await storedRecords(page, 'Issue', `repo:${String(repoId)}`)).toBe(0);
  await expect(indicator(page)).toContainText('Live');
  expect(problems).toEqual([]);
  await ctx.close();
  await ok(await api('PUT', `/repos/${USER}/${REPO}/collaborators/${ALICE.user}`, {permission: 'write'}), 'add collaborator back');
});
