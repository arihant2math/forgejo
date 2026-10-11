// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Reviewing a pull request in the app: the Files tab's line cursor and comment
// buttons, the range of changes shown, replies kept in their conversation, and
// asking a reviewer again.

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {CodeSource, codeSource} from '../../code/source.ts';
import type {NextConfig, Review} from '../../protocol/types.gen.ts';
import {comment, fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';
import {saveDraft} from '../../code/review.ts';
import {editing} from '../../intents/session.ts';

const BASE = 'b'.repeat(40);
const MID = 'd'.repeat(40);
const HEAD = 'c'.repeat(40);

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

/** a.txt: one context line, one line changed, one added, one context line. */
const DIFF = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+three\n four\n';
/** Since the review (MID → HEAD): only the added line. */
const SINCE = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n TWO\n+three\n four\n';
/** One commit's own changes (MID against its parent). */
const FIRST = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n four\n';

let fetches: {url: string; method: string; body?: unknown}[] = [];

beforeEach(() => {
  // jsdom lays nothing out: a view's size for the virtualized diff, so that its rows mount.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200);
  Object.assign(Element.prototype, {scrollTo: () => undefined});
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.spyOn(CodeSource.prototype, 'preheat').mockImplementation(() => undefined);
  vi.spyOn(CodeSource.prototype, 'diffHighlight').mockResolvedValue(null);
  fetches = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    fetches.push({url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined});
    return Promise.resolve(new Response('{}', {status: init?.method === 'POST' ? 201 : 404, headers: {'Content-Type': 'application/json'}}));
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const review = (id: number, reviewer: number, state: string, commit: string, at: string, extra: Partial<Review> = {}): Review => ({
  id, issue_id: 300, state, reviewer_id: reviewer, reviewer_team_id: 0, original_author: '', body: '', body_html: '', official: true, commit_id: commit,
  stale: false, dismissed: false, created_at: at, updated_at: at, ...extra,
});

/** acme/website#4 by bob, which alice (a writer) reviews; carol reviewed it before. */
function session() {
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'member'}]}});
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('User', 'repo:20', user(2, 'bob'));
  s.data.put('User', 'repo:20', user(3, 'carol'));
  s.data.put('User', 'org:9', user(9, 'acme', 'organization'));
  s.data.put('Repository', 'repo:20', repo(20, user(9, 'acme', 'organization'), 'website'));
  s.data.put('Access', 'user:1', {id: 1, user_id: 1, repo_id: 20, permission: 'write'});
  s.data.put('Issue', 'repo:20', issue(300, 20, 4, 'Uppercase two', {is_pull: true, poster_id: 2}));
  s.data.put('PullRequest', 'repo:20', {
    id: 30, issue_id: 300, number: 4, status: 'mergeable', head_repo_id: 20, base_repo_id: 20, head_branch: 'feature', base_branch: 'main', merge_base: BASE,
    allow_maintainer_edit: false, merged: false, merge_commit_sha: '', merger_id: 0, commits_ahead: 2, commits_behind: 0, conflicted_files: [], flow: 0,
  });
  s.data.put('Branch', 'repo:20', {id: 1, repo_id: 20, name: 'feature', commit_id: HEAD, commit_message: '', commit_time: T, pusher_id: 2, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T});
  s.auth.token = () => Promise.resolve('token');
  return s;
}

async function open(s: ReturnType<typeof session>, path: string) {
  const app = createApp(config, s);
  const src = codeSource(app);
  if (!src) throw new Error('no code source');
  src.cache.put(CodeSource.diffKey(20, BASE, HEAD), DIFF);
  src.cache.put(CodeSource.diffKey(20, MID, HEAD), SINCE);
  src.cache.put(CodeSource.diffKey(20, '', MID), FIRST);
  src.cache.put(`compare:20:${BASE}:${HEAD}`, {total: 2, commits: [
    {sha: HEAD, message: 'Add three', authorName: 'Bob', authorEmail: 'b@x', authorLogin: 'bob', date: T, parents: [MID]},
    {sha: MID, message: 'Uppercase two', authorName: 'Bob', authorEmail: 'b@x', authorLogin: 'bob', date: T, parents: [BASE]},
  ]});
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return app;
}

/** The diff's list item showing a line's text. */
async function lineRow(text: string): Promise<HTMLElement> {
  const list = await screen.findByRole('list', {name: 'Changes'});
  const row = await waitFor(() => {
    const found = within(list).getAllByRole('listitem').find((li) => li.querySelector('.code-text')?.textContent === text);
    if (!found) throw new Error(`no line ${text}`);
    return found;
  });
  return row;
}

test('a click on a line makes it the cursor line: Enter comments on the line clicked, and its comment button shows', async () => {
  await open(session(), '/acme/website/pulls/4?tab=files');
  const list = await screen.findByRole('list', {name: 'Changes'});
  const three = await lineRow('three');
  // The line's own comment button (hidden until hover, or the cursor's line: touch screens have no hover).
  expect(three.querySelector('[data-active]')).toBeNull();
  fireEvent.click(three.querySelector('.code-text') ?? three);
  const active = list.getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  expect(three.querySelector(`[id="${active ?? ''}"]`)).not.toBeNull();
  expect(three.querySelector('[data-active]')).not.toBeNull();
  expect(document.activeElement).toBe(list);
  fireEvent.keyDown(list, {key: 'Enter'});
  const field = await screen.findByRole('textbox', {name: 'Review comment'});
  // The composer opens in the thread row right under the line clicked.
  const thread = field.closest('[role="listitem"]');
  expect(Number(thread?.getAttribute('data-index'))).toBe(Number(three.getAttribute('data-index')) + 1);
});

test('a line comment starts a review, and the next one is added to it', async () => {
  const app = await open(session(), '/acme/website/pulls/4?tab=files');
  fireEvent.click(within(await lineRow('three')).getByRole('button', {name: 'Comment on line 3'}));
  expect(await screen.findByRole('button', {name: /Start a review/})).toBeTruthy();
  expect(screen.queryByRole('button', {name: /Add review comment/})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
  // A draft kept for the review (what Start a review keeps).
  act(() => {
    saveDraft(editing(app).intents, {issueId: 300, repoId: 20, number: 4, anchor: {path: 'a.txt', side: 'new', line: 3, commit: HEAD}, text: 'Why three?'});
  });
  expect(await screen.findByText('1 pending comment')).toBeTruthy();
  fireEvent.click(within(await lineRow('four')).getByRole('button', {name: 'Comment on line 4'}));
  expect(await screen.findByRole('button', {name: /Add review comment/})).toBeTruthy();
  expect(screen.queryByRole('button', {name: /Start a review/})).toBeNull();
  expect(screen.getByRole('button', {name: /Add single comment/})).toBeTruthy();
});

test('the range menu shows the changes since the viewer\'s last review, or one commit\'s', async () => {
  const s = session();
  s.data.put('Review', 'issue:300', review(40, 1, 'REQUEST_CHANGES', MID, '2026-10-02T00:00:00Z'));
  await open(s, '/acme/website/pulls/4?tab=files');
  await lineRow('three');
  expect(screen.getByText('two')).toBeTruthy(); // all changes: the removed line
  const trigger = screen.getByRole('button', {name: 'All changes: choose the changes shown'});
  fireEvent.pointerDown(trigger, {button: 0, ctrlKey: false});
  expect(await screen.findByText('1 commit since your last review')).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitemradio', {name: 'Changes since your last review'}));
  await waitFor(() => {
    expect(screen.queryByText('two')).toBeNull();
  });
  await lineRow('three');
  expect(screen.getByRole('button', {name: 'Changes since your last review: choose the changes shown'})).toBeTruthy();
  // The head's lines still take comments.
  expect(within(await lineRow('three')).getByRole('button', {name: 'Comment on line 3'})).toBeTruthy();
  // One commit's own changes: read-only (its lines are not the head's).
  fireEvent.pointerDown(screen.getByRole('button', {name: /choose the changes shown/}), {button: 0, ctrlKey: false});
  fireEvent.click(await screen.findByRole('menuitemradio', {name: /Uppercase two/}));
  await waitFor(() => {
    expect(screen.queryByText('three')).toBeNull();
  });
  expect(within(await lineRow('TWO')).queryByRole('button', {name: /Comment on/})).toBeNull();
});

test('"since your last review" follows a newer review, and shows all the changes once one is at the head', async () => {
  const s = session();
  s.data.put('Review', 'issue:300', review(40, 1, 'COMMENT', MID, '2026-10-02T00:00:00Z'));
  await open(s, '/acme/website/pulls/4?tab=files');
  await lineRow('three');
  fireEvent.pointerDown(screen.getByRole('button', {name: /choose the changes shown/}), {button: 0, ctrlKey: false});
  fireEvent.click(await screen.findByRole('menuitemradio', {name: 'Changes since your last review'}));
  expect(await screen.findByRole('button', {name: 'Changes since your last review: choose the changes shown'})).toBeTruthy();
  act(() => {
    s.data.put('Review', 'issue:300', review(41, 1, 'APPROVED', HEAD, '2026-10-03T00:00:00Z'));
  });
  expect(await screen.findByRole('button', {name: 'All changes: choose the changes shown'})).toBeTruthy();
  expect(await screen.findByText('two')).toBeTruthy();
});

test('a reply shows in the conversation it answers, not as an empty review of its own', async () => {
  const s = session();
  const hunk = '@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+three';
  s.data.put('Review', 'issue:300', review(40, 3, 'REQUEST_CHANGES', HEAD, '2026-10-02T00:00:00Z'));
  s.data.put('Comment', 'issue:300', comment(500, 300, 'Why three?', {type: 'code', poster_id: 3, review_id: 40, path: 'a.txt', line: 3, commit_id: HEAD, diff_hunk: hunk, created_at: '2026-10-02T00:00:00Z', body_html: '<p>Why three?</p>'}));
  // Bob's Reply: a one-comment COMMENT review without a body (Forgejo's data for it).
  s.data.put('Review', 'issue:300', review(41, 2, 'COMMENT', HEAD, '2026-10-03T00:00:00Z'));
  s.data.put('Comment', 'issue:300', comment(501, 300, '', {type: 'review', poster_id: 2, review_id: 41, created_at: '2026-10-03T00:00:00Z'}));
  s.data.put('Comment', 'issue:300', comment(502, 300, 'Because four.', {type: 'code', poster_id: 2, review_id: 41, path: 'a.txt', line: 3, commit_id: HEAD, diff_hunk: hunk, created_at: '2026-10-03T00:00:01Z', body_html: '<p>Because four.</p>'}));
  await open(s, '/acme/website/pulls/4');
  const answer = await screen.findByText('Because four.');
  const question = screen.getByText('Why three?');
  const activity = screen.getByRole('region', {name: 'Activity'});
  // One conversation: one thread with both comments, one Reply.
  expect(within(activity).getAllByRole('button', {name: 'Reply'})).toHaveLength(1);
  const thread = within(activity).getByRole('button', {name: 'Reply'}).parentElement?.parentElement;
  expect(thread?.contains(question) && thread.contains(answer)).toBe(true);
  // No "reviewed" entry with an empty body for the reply.
  expect(within(activity).queryByText('reviewed')).toBeNull();
  expect(within(activity).queryByText('No text.')).toBeNull();
  expect(within(activity).getByText('requested changes')).toBeTruthy();
});

test('a reviewer who reviewed can be asked again from the sidebar; the verdict is named', async () => {
  const s = session();
  s.data.put('Review', 'issue:300', review(40, 3, 'REQUEST_CHANGES', MID, '2026-10-02T00:00:00Z'));
  await open(s, '/acme/website/pulls/4');
  const sidebar = await screen.findByRole('complementary', {name: 'Properties'});
  expect(await within(sidebar).findByText('Changes requested')).toBeTruthy();
  fireEvent.click(within(sidebar).getByRole('button', {name: 'Re-request review from carol'}));
  await waitFor(() => {
    expect(within(sidebar).queryByRole('button', {name: /Re-request review/})).toBeNull();
  });
  expect(within(sidebar).getByText('Review requested')).toBeTruthy();
  await waitFor(() => {
    expect(fetches).toContainEqual({url: '/api/v1/repos/acme/website/pulls/4/requested_reviewers', method: 'POST', body: {reviewers: ['carol']}});
  });
});

test('a suggestion renders as a suggested change with its commit action', async () => {
  const s = session();
  const hunk = '@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+three';
  s.data.put('Review', 'issue:300', review(40, 3, 'COMMENT', HEAD, '2026-10-02T00:00:00Z', {body: 'See inline.', body_html: '<p>See inline.</p>'}));
  s.data.put('Comment', 'issue:300', comment(500, 300, '```suggestion\nthree!\n```', {type: 'code', poster_id: 3, review_id: 40, path: 'a.txt', line: 3, commit_id: HEAD, diff_hunk: hunk, created_at: '2026-10-02T00:00:00Z'}));
  await open(s, '/acme/website/pulls/4');
  const change = await screen.findByRole('region', {name: 'Suggested change'});
  expect(within(change).getByText('three')).toBeTruthy();
  expect(within(change).getByText('three!')).toBeTruthy();
  expect(within(change).getByRole('button', {name: 'Commit suggestion'})).toBeTruthy();
  expect(within(change).getByRole('button', {name: 'Add to batch'})).toBeTruthy();
});

test('the line composer inserts a suggestion of the line', async () => {
  await open(session(), '/acme/website/pulls/4?tab=files');
  fireEvent.click(within(await lineRow('three')).getByRole('button', {name: 'Comment on line 3'}));
  await screen.findByRole('textbox', {name: 'Review comment'});
  fireEvent.click(screen.getByRole('button', {name: 'Suggest change'}));
  await waitFor(() => {
    expect(screen.getByRole('textbox', {name: 'Review comment'}).textContent).toContain('```suggestion');
  });
  expect(screen.getByRole('textbox', {name: 'Review comment'}).textContent).toContain('three');
});
