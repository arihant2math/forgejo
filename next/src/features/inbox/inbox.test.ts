// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import type {Notification} from '../../protocol/types.gen.ts';
import {activityOf, inboxRows, togglePin} from './inbox.ts';

const note = (id: number, repo: number, status: string, at: string): Notification => ({
  id, user_id: 1, repo_id: repo, status, subject: 'issue', issue_id: id * 10, comment_id: 0, actor_id: 0, created_at: at, updated_at: at,
});
const NOTES = [
  note(1, 1, 'unread', '2026-10-01T00:00:00Z'),
  note(2, 2, 'read', '2026-10-03T00:00:00Z'),
  note(3, 1, 'pinned', '2026-09-01T00:00:00Z'),
  note(4, 2, 'unread', '2026-10-02T00:00:00Z'),
];
const ctx = (over: Record<number, string> = {}) => ({status: (n: Notification) => over[n.id] ?? n.status, repoName: (id: number) => ({1: 'a/one', 2: 'b/two'})[id] ?? ''});

test('pinned first, then newest first; no header without pins', () => {
  expect(inboxRows(NOTES, {unread: false, byRepo: false}, ctx()).rows).toEqual([
    {type: 'group', key: 'pinned', label: 'Pinned', count: 1}, {type: 'note', id: 3},
    {type: 'group', key: 'rest', label: 'Latest', count: 3}, {type: 'note', id: 2}, {type: 'note', id: 4}, {type: 'note', id: 1},
  ]);
  const unpinned = inboxRows(NOTES, {unread: false, byRepo: false}, ctx({3: 'read'}));
  expect(unpinned.rows.every((r) => r.type === 'note')).toBe(true);
  expect(unpinned.ids).toEqual([2, 4, 1, 3]);
});

test('unread only, through the overlay', () => {
  expect(inboxRows(NOTES, {unread: true, byRepo: false}, ctx()).ids).toEqual([4, 1]);
  expect(inboxRows(NOTES, {unread: true, byRepo: false}, ctx({4: 'read', 2: 'unread'})).ids).toEqual([2, 1]);
});

test('by repository: groups ordered by their newest notification', () => {
  const r = inboxRows(NOTES, {unread: false, byRepo: true}, ctx());
  expect(r.rows.flatMap((x) => (x.type === 'group' ? [x.label] : []))).toEqual(['Pinned', 'b/two', 'a/one']);
  expect(r.ids).toEqual([3, 2, 4, 1]);
});

test('togglePin', () => {
  expect(togglePin('pinned')).toBe('read');
  expect(togglePin('unread')).toBe('pinned');
});

test('triage keeps a row in place: a status change moves updated_at, not the activity', () => {
  const n = (id: number, updated: string) => ({...NOTES[0], id, updated_at: updated, status: 'read'}) as Notification;
  const issueTime: Record<number, string> = {1: '2026-01-02T00:00:00Z', 2: '2026-01-01T00:00:00Z'};
  // #2 was just read (its updated_at is now), but its issue's last activity is older than #1's.
  const notes = [n(1, '2026-01-02T00:00:00Z'), n(2, '2026-03-01T00:00:00Z')];
  const r = inboxRows(notes, {unread: false, byRepo: false}, {...ctx(), activity: (x) => activityOf(x, issueTime[x.id])});
  expect(r.ids).toEqual([1, 2]);
  expect(activityOf(n(3, '2026-01-05T00:00:00Z'), undefined)).toBe('2026-01-05T00:00:00Z');
});
