// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {Pool} from '../../data/pool.ts';
import type {Review} from '../../protocol/types.gen.ts';
import {comment} from '../../test/fakeSession.ts';
import {conversationReplies, replyOnlyReview, replyRoot} from './resolve.tsx';

let v = 1;
const review = (id: number, state: string, body = ''): Review => ({
  id, issue_id: 1, state, reviewer_id: 2, reviewer_team_id: 0, original_author: '', body, body_html: '', official: false, commit_id: 'c', stale: false,
  dismissed: false, created_at: `2026-01-0${String(id)}T00:00:00Z`, updated_at: '',
});
const code = (id: number, reviewId: number, line: number, at: string) => comment(id, 1, `comment ${String(id)}`, {type: 'code', review_id: reviewId, path: 'a.go', line, created_at: at});

function pool() {
  const p = new Pool();
  const put = (m: 'Review' | 'Comment', d: {id: number}) => {
    p.batch(() => p.load(m, [{id: d.id, g: 'issue:1', v: v++, d} as never]));
  };
  put('Review', review(1, 'REQUEST_CHANGES'));
  put('Comment', code(10, 1, 5, '2026-01-01T00:00:00Z'));
  // A reply: its own COMMENT review, with an empty summary.
  put('Review', review(2, 'COMMENT'));
  put('Comment', comment(20, 1, '', {type: 'review', review_id: 2, created_at: '2026-01-02T00:00:00Z'}));
  put('Comment', code(21, 2, 5, '2026-01-02T00:00:01Z'));
  // A review that answers and also comments on another line: an entry of its own.
  put('Review', review(3, 'COMMENT'));
  put('Comment', code(30, 3, 5, '2026-01-03T00:00:00Z'));
  put('Comment', code(31, 3, 9, '2026-01-03T00:00:01Z'));
  // A reply with a verdict: an entry of its own (its comment still shows in the thread).
  put('Review', review(4, 'APPROVED'));
  put('Comment', code(40, 4, 5, '2026-01-04T00:00:00Z'));
  // A pending review's comment: not shown in the conversation.
  put('Review', review(5, 'PENDING'));
  put('Comment', code(50, 5, 5, '2026-01-05T00:00:00Z'));
  return p;
}

test('replies are grouped under the comment that started their conversation', () => {
  const p = pool();
  const get = (id: number) => p.model('Comment').get(id);
  const root = get(10);
  if (!root) throw new Error('no root');
  expect(replyRoot(p, root)).toBeUndefined();
  for (const id of [21, 30, 40]) expect(replyRoot(p, get(id) ?? root)?.id).toBe(10);
  expect(replyRoot(p, get(31) ?? root)).toBeUndefined(); // starts its own conversation (another line)
  expect(conversationReplies(p, root).map((c) => c.id)).toEqual([21, 30, 40]);
});

test('only a review that does nothing but reply is not an entry of its own', () => {
  const p = pool();
  expect(replyOnlyReview(p, 1)).toBe(false);
  expect(replyOnlyReview(p, 2)).toBe(true);
  expect(replyOnlyReview(p, 3)).toBe(false);
  expect(replyOnlyReview(p, 4)).toBe(false);
  // A reply with a summary is a review the reviewer wrote.
  p.batch(() => p.load('Review', [{id: 2, g: 'issue:1', v: v++, d: review(2, 'COMMENT', 'Also see the docs.')} as never]));
  expect(replyOnlyReview(p, 2)).toBe(false);
});
