// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {createMemoryHistory} from '@tanstack/react-router';
import {act, configure, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
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

// Cold diff loading exceeds default waits on busy machines; allow more time.
configure({asyncUtilTimeout: 10_000});
vi.setConfig({testTimeout: 30_000});

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

const DIFF = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+three\n four\n';
const SINCE = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n one\n TWO\n+three\n four\n';
const FIRST = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n four\n';

let fetches: {url: string; method: string; body?: unknown}[] = [];
let answer: (url: string, method: string) => Response | undefined = () => undefined;

beforeEach(() => {
  // jsdom has no layout; provide viewport dimensions so virtualized rows mount.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1200);
  vi.spyOn(CodeSource.prototype, 'preheat').mockImplementation(() => undefined);
  vi.spyOn(CodeSource.prototype, 'diffHighlight').mockResolvedValue(null);
  fetches = [];
  answer = () => undefined;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    fetches.push({url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined});
    const own = answer(url, init?.method ?? 'GET');
    if (own) return Promise.resolve(own);
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

async function lineRow(text: string): Promise<HTMLElement> {
  const list = await screen.findByRole('list', {name: 'Changes'});
  const row = await waitFor(() => {
    const found = within(list).getAllByRole('listitem').find((li) => li.querySelector('.code-text')?.textContent === text);
    if (!found) throw new Error(`no line ${text}`);
    return found;
  });
  return row;
}

test('pull commit rows keep their summaries, authors and commit links', async () => {
  await open(session(), '/acme/website/pulls/4?tab=commits');
  const list = await screen.findByRole('listbox', {name: 'Commits'}, {timeout: 10_000});
  const rows = await within(list).findAllByRole('option');
  expect(rows).toHaveLength(2);
  const first = rows[0];
  if (!first) throw new Error('no first commit');
  expect(first.textContent).toContain('Add three');
  expect(first.getAttribute('href')).toContain(`/commit/${HEAD}`);
  expect(within(first).getByText('Bob')).toBeTruthy();
  expect(within(first).getByTitle(HEAD)).toBeTruthy();
});

test('the pull request tabs follow GitHub: Conversation, Commits, Checks, Files changed, with the counts the pool knows', async () => {
  const s = session();
  s.data.put('CommitStatus', 'repo:20', {id: 70, repo_id: 20, sha: HEAD, index: 1, context: 'ci', state: 'success', target_url: '', description: '', creator_id: 1, created_at: T, updated_at: T});
  await open(s, '/acme/website/pulls/4');
  const nav = await screen.findByRole('navigation', {name: 'Pull request'});
  const tabs = within(nav).getAllByRole('link');
  expect(tabs.map((t) => t.textContent?.replace(/\s+/g, ' '))).toEqual(['Conversation', 'Commits2 (2)', 'Checks1 (1)', 'Files changed']);
});

test('a click on a line makes it the cursor line: Enter comments on the line clicked, and its comment button shows', async () => {
  await open(session(), '/acme/website/pulls/4?tab=files');
  const list = await screen.findByRole('list', {name: 'Changes'});
  const three = await lineRow('three');
  expect(three.querySelector('[data-active]')).toBeNull();
  fireEvent.click(three.querySelector('.code-text') ?? three);
  const active = list.getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  expect(three.querySelector(`[id="${active ?? ''}"]`)).not.toBeNull();
  expect(three.querySelector('[data-active]')).not.toBeNull();
  expect(document.activeElement).toBe(list);
  fireEvent.keyDown(list, {key: 'Enter'});
  const field = await screen.findByRole('textbox', {name: 'Review comment'});
  const thread = field.closest('[role="listitem"]');
  expect(Number(thread?.getAttribute('data-index'))).toBe(Number(three.getAttribute('data-index')) + 1);
});

test('a line comment starts a review, and the next one is added to it', async () => {
  const app = await open(session(), '/acme/website/pulls/4?tab=files');
  fireEvent.click(within(await lineRow('three')).getByRole('button', {name: 'Comment on line 3'}));
  expect(await screen.findByRole('button', {name: /Start a review/})).toBeTruthy();
  expect(screen.queryByRole('button', {name: /Add review comment/})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
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
  // Keep the chevron in Primer's trailing grid cell so it cannot wrap beneath the label.
  expect(trigger.querySelector('[data-component="trailingVisual"] svg')).not.toBeNull();
  expect(trigger.querySelector('[data-component="text"] svg')).toBeNull();
  fireEvent.click(trigger);
  expect(await screen.findByText('1 commit since your last review')).toBeTruthy();
  fireEvent.click(screen.getByRole('menuitemradio', {name: 'Changes since your last review'}));
  await waitFor(() => {
    expect(screen.queryByText('two')).toBeNull();
  });
  await lineRow('three');
  expect(screen.getByRole('button', {name: 'Changes since your last review: choose the changes shown'})).toBeTruthy();
  expect(within(await lineRow('three')).getByRole('button', {name: 'Comment on line 3'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: /choose the changes shown/}));
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
  fireEvent.click(screen.getByRole('button', {name: /choose the changes shown/}));
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
  // Forgejo models a reply as a COMMENT review with no summary.
  s.data.put('Review', 'issue:300', review(41, 2, 'COMMENT', HEAD, '2026-10-03T00:00:00Z'));
  s.data.put('Comment', 'issue:300', comment(501, 300, '', {type: 'review', poster_id: 2, review_id: 41, created_at: '2026-10-03T00:00:00Z'}));
  s.data.put('Comment', 'issue:300', comment(502, 300, 'Because four.', {type: 'code', poster_id: 2, review_id: 41, path: 'a.txt', line: 3, commit_id: HEAD, diff_hunk: hunk, created_at: '2026-10-03T00:00:01Z', body_html: '<p>Because four.</p>'}));
  await open(s, '/acme/website/pulls/4');
  const answer = await screen.findByText('Because four.');
  const question = screen.getByText('Why three?');
  const activity = screen.getByRole('region', {name: 'Activity'});
  expect(within(activity).getAllByRole('button', {name: 'Reply'})).toHaveLength(1);
  const thread = within(activity).getByRole('button', {name: 'Reply'}).parentElement?.parentElement;
  expect(thread?.contains(question) && thread.contains(answer)).toBe(true);
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


test('"Add single comment" posts a one-comment review; the conversation shows the comment once, without an empty summary', async () => {
  const s = session();
  await open(s, '/acme/website/pulls/4?tab=files');
  fireEvent.click(within(await lineRow('three')).getByRole('button', {name: 'Comment on line 3'}));
  await screen.findByRole('textbox', {name: 'Review comment'});
  fireEvent.click(screen.getByRole('button', {name: 'Suggest change'}));
  const single = screen.getByRole('button', {name: /Add single comment/});
  await waitFor(() => {
    expect(single.hasAttribute('disabled') || single.getAttribute('aria-disabled') === 'true').toBe(false);
  });
  fireEvent.click(single);
  await waitFor(() => {
    expect(fetches.some((f) => f.method === 'POST' && f.url.endsWith('/repos/acme/website/pulls/4/reviews'))).toBe(true);
  });
  const sent = fetches.find((f) => f.method === 'POST' && f.url.endsWith('/pulls/4/reviews'))?.body as {event: string; body: string; comments: {path: string; new_position: number}[]};
  expect(sent.event).toBe('COMMENT');
  expect(sent.comments).toEqual([expect.objectContaining({path: 'a.txt', new_position: 3})]);
});

test('a single line comment\'s review (COMMENT, empty summary) shows its comment once and no "No text." card', async () => {
  const s = session();
  const hunk = '@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+three';
  // Forgejo stores single comments with an empty summary and one line comment.
  s.data.put('Review', 'issue:300', review(53, 1, 'COMMENT', HEAD, '2026-10-02T00:00:00Z'));
  s.data.put('Comment', 'issue:300', comment(530, 300, '', {type: 'review', poster_id: 1, review_id: 53, created_at: '2026-10-02T00:00:00Z'}));
  s.data.put('Comment', 'issue:300', comment(531, 300, 'This swallows every error.', {type: 'code', poster_id: 1, review_id: 53, path: 'a.txt', line: 3, commit_id: HEAD, diff_hunk: hunk, created_at: '2026-10-02T00:00:00Z', body_html: '<p>This swallows every error.</p>'}));
  await open(s, '/acme/website/pulls/4');
  const activity = await screen.findByRole('region', {name: 'Activity'});
  expect(await within(activity).findAllByText('This swallows every error.')).toHaveLength(1);
  expect(within(activity).queryByText('No text.')).toBeNull();
  expect(within(activity).getAllByRole('article')).toHaveLength(1); // the comment's card; the review is a timeline entry, not a card around it
  expect(within(activity).getAllByRole('button', {name: 'Reply'})).toHaveLength(1);
});

test('touch (no hover): a tap on a line shows its comment button, and a tap on it opens the composer', async () => {
  await open(session(), '/acme/website/pulls/4?tab=files');
  const row = await lineRow('four');
  const button = within(row).getByRole('button', {name: 'Comment on line 4'});
  // Touch devices need the cursor-line control without a hover media-query gate.
  const shown = button.parentElement;
  expect(shown?.className).toContain('invisible');
  expect(shown?.className).toContain('group-data-active:visible');
  expect(button.closest('[data-active]')).toBeNull();
  fireEvent.pointerDown(row.querySelector('.code-text') ?? row, {pointerType: 'touch'});
  fireEvent.click(row.querySelector('.code-text') ?? row);
  expect(button.closest('.group')?.hasAttribute('data-active')).toBe(true);
  fireEvent.click(button);
  const field = await screen.findByRole('textbox', {name: 'Review comment'});
  expect(Number(field.closest('[role="listitem"]')?.getAttribute('data-index'))).toBe(Number(row.getAttribute('data-index')) + 1);
});

test('a merge refused because someone else merged it first says so, without a failure', async () => {
  const s = session();
  s.data.put('RepoUnit', 'repo:20', {id: 7, repo_id: 20, type: 'pulls', config: {}, default_permissions: '', created_at: T});
  answer = (url, method) => {
    const json = (v: unknown, status: number) => new Response(JSON.stringify(v), {status, headers: {'Content-Type': 'application/json'}});
    if (method === 'POST' && url.endsWith('/api/v1/repos/acme/website/pulls/4/merge')) return json({message: '', url: 'http://localhost/api/swagger'}, 405);
    if (method === 'GET' && url.endsWith('/api/v1/repos/acme/website/pulls/4')) return json({number: 4, merged: true, merged_by: {login: 'carol'}}, 200);
    return undefined;
  };
  const app = await open(s, '/acme/website/pulls/4');
  fireEvent.click(await screen.findByRole('button', {name: /Create a merge commit…/}));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', {name: 'Merge'}));
  await waitFor(() => {
    expect(app.ui.notices.map((n) => n.title)).toContain('Already merged');
  });
  const notice = app.ui.notices.find((n) => n.title === 'Already merged');
  expect(notice?.tone).toBe('neutral');
  expect(notice?.description).toBe('carol merged this pull request before your merge went through.');
  expect(app.ui.notices.some((n) => n.tone === 'danger')).toBe(false);
});

test('a merge refused for another reason (empty 405, not merged) says what to do', async () => {
  const s = session();
  s.data.put('RepoUnit', 'repo:20', {id: 7, repo_id: 20, type: 'pulls', config: {}, default_permissions: '', created_at: T});
  answer = (url, method) => {
    const json = (v: unknown, status: number) => new Response(JSON.stringify(v), {status, headers: {'Content-Type': 'application/json'}});
    if (method === 'POST' && url.endsWith('/pulls/4/merge')) return json({message: ''}, 405);
    if (method === 'GET' && url.endsWith('/api/v1/repos/acme/website/pulls/4')) return json({number: 4, merged: false}, 200);
    return undefined;
  };
  const app = await open(s, '/acme/website/pulls/4');
  fireEvent.click(await screen.findByRole('button', {name: /Create a merge commit…/}));
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', {name: 'Merge'}));
  await waitFor(() => {
    expect(app.ui.notices.map((n) => n.title)).toContain('Merging failed');
  });
  expect(app.ui.notices.find((n) => n.title === 'Merging failed')?.description).toBe('Forgejo could not do it now (the branch changed, or a hook refused it). Check the pull request, then try again.');
});
