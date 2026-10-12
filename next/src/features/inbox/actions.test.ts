// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {beforeEach, expect, test, vi} from 'vitest';
import type {App} from '../../app/store.ts';
import {unsubscribe, unsubscribeReason} from './actions.ts';

const mocks = vi.hoisted(() => ({submit: vi.fn<(i: {kind: string; add?: boolean; status?: string}) => void>(), notify: vi.fn<(app: unknown, notice: {action: {run: () => void}}) => void>(), status: 'unread', subscribed: true}));
vi.mock('../../intents/editing.ts', () => ({editing: () => ({overlay: {}, intents: {submit: mocks.submit}})}));
vi.mock('../../intents/view.ts', () => ({notificationStatus: () => mocks.status, issueSubscribed: () => mocks.subscribed}));
vi.mock('../../app/notices.ts', () => ({notify: mocks.notify}));

function app(subject = 'issue'): App {
  const notes = new Map([1, 2].map((id) => [id, {data: {id, subject, issue_id: id + 10, repo_id: 3}}]));
  return {session: {userId: 7, data: {pool: {model: (name: string) => ({get: (id: number) => name === 'Notification' ? notes.get(id) : {id}})}}}} as unknown as App;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = 'unread';
  mocks.subscribed = true;
});

test('unsubscribe selection queues offline intents and Undo restores subscription and read state', () => {
  unsubscribe(app(), [1, 2], true);
  expect(mocks.submit.mock.calls.map(([i]) => [i.kind, i.add ?? i.status])).toEqual([
    ['issue.subscribe', false], ['issue.subscribe', false], ['notification.status', 'read'], ['notification.status', 'read'],
  ]);
  mocks.status = 'read';
  mocks.notify.mock.calls.at(0)?.[1].action.run();
  expect(mocks.submit.mock.calls.slice(4).map(([i]) => [i.kind, i.add ?? i.status])).toEqual([
    ['issue.subscribe', true], ['notification.status', 'unread'], ['issue.subscribe', true], ['notification.status', 'unread'],
  ]);
});

test('unsupported subjects explain why and never queue changes', () => {
  expect(unsubscribeReason(app('commit'), [1])).toContain('Only issue and pull request');
  unsubscribe(app('commit'), [1], true);
  expect(mocks.submit).not.toHaveBeenCalled();
});

test('Undo preserves a prior explicit unsubscribe and pinned status', () => {
  mocks.status = 'pinned';
  mocks.subscribed = false;
  unsubscribe(app(), [1], true);
  mocks.notify.mock.calls.at(0)?.[1].action.run();
  expect(mocks.submit.mock.calls.map(([i]) => i.add)).toEqual([false, false]);
});
