// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {Pool} from '../../data/pool.ts';
import type {Notification} from '../../protocol/types.gen.ts';
import {reasonOf} from './reason.ts';
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

test('mentions and review requests the server names, also without the issue\'s timeline on this device (#168)', () => {
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
  // Without the server's answer the comment (not on this device) cannot say: "Commented".
  expect(reasonOf(pool, n(10), 1, 'alice')).toEqual({why: 'Commented', actor: 3});
  expect(reasonOf(pool, n(10), 1, 'alice', server)).toEqual({why: 'Mentioned', actor: 3});
  expect(reasonOf(pool, n(11), 1, 'alice', server)).toEqual({why: 'Review requested', actor: 3});
  expect(reasonOf(pool, n(12), 1, 'alice', server)).toEqual({why: 'Commented', actor: 3});
  // Issues that are not on this device at all.
  expect(reasonOf(pool, n(20), 1, 'alice', server)?.why).toBe('Mentioned');
  expect(reasonOf(pool, n(21, 0), 1, 'alice', server)?.why).toBe('Review requested');
  expect(reasonOf(pool, n(22), 1, 'alice', server)?.why).toBe('Commented');
});
