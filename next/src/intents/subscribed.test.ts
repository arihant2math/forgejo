// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {comment, fakeSession, issue, T} from '../test/fakeSession.ts';
import {Overlay} from './overlay.ts';
import {issueSubscribed} from './view.ts';

test('subscribed as Forgejo decides: a pending change, else the explicit choice, else watching the repository or taking part', () => {
  const s = fakeSession({userId: 5});
  const {data} = s;
  const o = new Overlay();
  data.put('Issue', 'repo:1', issue(10, 1, 1, 'X', {poster_id: 2}));
  const e = () => data.pool.model('Issue').get(10);
  const sub = () => {
    const i = e();
    if (!i) throw new Error('no issue');
    return issueSubscribed(data.pool, o, i, 5);
  };
  expect(sub()).toBe(false);
  // Took part: a review comment counts.
  data.put('Comment', 'issue:10', comment(1, 10, 'lgtm', {poster_id: 5, type: 'review'}));
  expect(sub()).toBe(true);
  // An explicit unsubscribe wins.
  data.put('IssueWatch', 'user:5', {id: 1, user_id: 5, issue_id: 10, is_watching: false, created_at: T, updated_at: T});
  expect(sub()).toBe(false);
  // A pending subscribe wins over that.
  o.add('a', [{t: 'member', model: 'IssueSubscriber', owner: 10, member: 5, present: true}]);
  expect(sub()).toBe(true);
});

test('watching the repository\'s issues subscribes', () => {
  const s = fakeSession({userId: 5});
  const o = new Overlay();
  s.data.put('Issue', 'repo:1', issue(10, 1, 1, 'X', {poster_id: 2}));
  s.data.put('Watch', 'user:5', {id: 1, user_id: 5, repo_id: 1, automatic: false, issues: true, pull_requests: false, releases: false, created_at: T, updated_at: T});
  const i = s.data.pool.model('Issue').get(10);
  expect(i && issueSubscribed(s.data.pool, o, i, 5)).toBe(true);
});
