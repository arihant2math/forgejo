// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {Pool} from '../../data/pool.ts';
import type {Notification} from '../../protocol/types.gen.ts';
import {participates, reasonOf} from './reason.ts';
import {parseThread} from './subject.ts';

test('a notification thread names its issue or pull request', () => {
  expect(parseThread({
    subject: {title: 'Try out the merge queue?', url: 'http://h/api/v1/repos/bob/sandbox/issues/1', type: 'Issue', state: 'open'},
    repository: {name: 'sandbox', owner: {login: 'bob'}},
  })).toEqual({title: 'Try out the merge queue?', owner: 'bob', repo: 'sandbox', number: 1, pull: false, state: 'open'});
  expect(parseThread({subject: {title: 'x', url: 'http://h/api/v1/repos/a/b/pulls/7', type: 'Pull', state: 'merged'}, repository: {name: 'b', owner: {login: 'a'}}}))
    .toMatchObject({number: 7, pull: true, state: 'merged'});
  expect(parseThread({subject: {title: 'a commit', url: 'http://h/api/v1/repos/a/b/commits/abc', type: 'Commit'}, repository: {name: 'b', owner: {login: 'a'}}})).toBeUndefined();
  expect(parseThread(undefined)).toBeUndefined();
});

test('mentions and review requests the server names, also without the issue\'s timeline on this device', () => {
  const pool = new Pool();
  const at = '2026-10-01T00:00:00Z';
  pool.batch(() => {
    pool.load('Issue', [10, 11, 12].map((id) => ({id, g: 'repo:1', v: 1, d: {
      id, repo_id: 1, number: id, poster_id: 3, original_author: '', original_author_id: 0, title: 't', content_version: 0, milestone_id: 0, priority: 0,
      state: 'open', is_pull: id === 11, comments: 0, ref: '', pin_order: 0, is_locked: false, created_at: at, updated_at: at,
    }})));
  });
  const n = (issueId: number, commentId = 7): Notification => ({
    id: issueId, user_id: 1, repo_id: 1, status: 'unread', subject: 'issue', issue_id: issueId, comment_id: commentId, actor_id: 3, created_at: at, updated_at: at,
  });
  const server = {mentioned: new Set([10, 20]), reviewRequested: new Set([11, 21])};
  expect(reasonOf(pool, n(10), 1, 'alice')).toEqual({why: 'Commented', actor: 3});
  expect(reasonOf(pool, n(10), 1, 'alice', server)).toEqual({why: 'Mentioned', actor: 3});
  expect(reasonOf(pool, n(11), 1, 'alice', server)).toEqual({why: 'Review requested', actor: 3});
  expect(reasonOf(pool, n(12), 1, 'alice', server)).toEqual({why: 'Commented', actor: 3});
  expect(reasonOf(pool, n(20), 1, 'alice', server)?.why).toBe('Mentioned');
  expect(reasonOf(pool, n(21, 0), 1, 'alice', server)?.why).toBe('Review requested');
  expect(reasonOf(pool, n(22), 1, 'alice', server)?.why).toBe('Commented');
});

test('Participating includes threads the viewer is mentioned in, assigned to or asked to review', () => {
  const pool = new Pool();
  const at = '2026-10-01T00:00:00Z';
  const me = 1;
  pool.batch(() => {
    pool.load('Issue', [30, 31, 32, 33, 34, 35, 36, 37].map((id) => ({id, g: 'repo:1', v: 1, d: {
      id, repo_id: 1, number: id, poster_id: id === 33 ? me : 3, original_author: '', original_author_id: 0, title: 't', content_version: 0, milestone_id: 0,
      priority: 0, state: 'open', is_pull: id === 35, comments: 0, ref: '', pin_order: 0, is_locked: false, created_at: at, updated_at: at,
    }})));
    pool.put('IssueAssignee', 900, 'repo:1', 1, {id: 900, issue_id: 31, assignee_id: me});
    pool.put('IssueAssignee', 901, 'repo:1', 1, {id: 901, issue_id: 32, assignee_id: 4});
    pool.put('Comment', 70, 'issue:36', 1, {id: 70, issue_id: 36, poster_id: 3, body: '@alice can you take this?'} as never);
    pool.put('Comment', 71, 'issue:34', 1, {id: 71, issue_id: 34, poster_id: me, body: 'on it'} as never);
    pool.put('Review', 80, 'issue:35', 1, {id: 80, issue_id: 35, reviewer_id: me, state: 'REQUEST_REVIEW'} as never);
  });
  const n = (issueId: number, commentId = 0): Notification => ({
    id: issueId, user_id: me, repo_id: 1, status: 'unread', subject: 'issue', issue_id: issueId, comment_id: commentId, actor_id: 3, created_at: at, updated_at: at,
  });
  const server = {mentioned: new Set([30, 40]), reviewRequested: new Set([41])};
  const p = (issueId: number, commentId = 0) => participates(pool, n(issueId, commentId), me, 'alice', server);
  expect(p(30)).toBe(true); // mentioned (the server says)
  expect(p(31)).toBe(true); // assigned
  expect(p(32)).toBe(false); // assigned to someone else
  expect(p(33)).toBe(true); // their own issue
  expect(p(34)).toBe(true); // they commented
  expect(p(35)).toBe(true); // review requested (on this device)
  expect(p(36, 70)).toBe(true); // mentioned in the notifying comment
  expect(p(37)).toBe(false); // none of these
  expect(p(40)).toBe(true);
  expect(p(41)).toBe(true);
  expect(p(42)).toBe(false);
  expect(participates(pool, n(33), 0, undefined, server)).toBe(false);
});
