// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {inboxSearch} from '../../app/search.ts';
import type {Notification} from '../../protocol/types.gen.ts';
import {parseView} from '../views/views.ts';
import {inboxRows, type InboxContext} from './inbox.ts';

test('inbox filters parse and survive saved view validation', () => {
  const search = inboxSearch({filter: 'unread', group: 'repo', reason: 'review-requested', repo: '42', type: 'pr', state: 'merged'});
  expect(search).toEqual({filter: 'unread', group: 'repo', reason: 'review-requested', repo: 42, type: 'pr', state: 'merged'});
  expect(inboxSearch({reason: 'bogus', repo: '-1', type: 'commit', state: 'all'})).toEqual({});
  expect(parseView({id: 'v', name: 'Reviews', path: '/notifications', search})?.search).toEqual(search);
  expect(inboxSearch({filter: 'all', reason: 'mentioned'})).toEqual({filter: 'all', reason: 'mentioned'});
  expect(parseView({id: 'v', name: 'Everything', path: '/notifications', search: {filter: 'all'}})?.search).toEqual({filter: 'all'});
});

test('inbox filters intersect, including unread overrides and unknown subjects', () => {
  const notes = [1, 2, 3].map((id) => ({id, repo_id: id === 3 ? 2 : 1, status: 'unread', updated_at: String(id)}) as Notification);
  const ctx: InboxContext = {
    status: (n) => n.id === 2 ? 'read' : n.status,
    repoName: () => 'owner/repo',
    reason: () => 'review-requested',
    subject: (n) => n.id === 3 ? undefined : {type: 'pr', state: 'open'},
  };
  const view = {unread: true, byRepo: true, repo: 1, reason: 'review-requested', type: 'pr', state: 'open'} as const;
  expect(inboxRows(notes, view, ctx).ids).toEqual([1]);
  expect(inboxRows(notes, {...view, unread: false}, ctx).ids).toEqual([2, 1]);
  expect(inboxRows(notes, {...view, state: 'merged'}, ctx).ids).toEqual([]);
  expect(inboxRows(notes, {...view, reason: 'mentioned'}, ctx).ids).toEqual([]);
});
