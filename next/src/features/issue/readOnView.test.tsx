// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {createMemoryHistory} from '@tanstack/react-router';
import {cleanup, render, screen, waitFor} from '@testing-library/react';
import {runInAction} from 'mobx';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {type App as AppState, createApp, type Session} from '../../app/store.ts';
import type {Intent} from '../../intents/intents.ts';
import {editing} from '../../intents/editing.ts';
import {notificationStatus} from '../../intents/view.ts';
import type {NextConfig, Notification} from '../../protocol/types.gen.ts';
import {fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

beforeEach(() => {
  Element.prototype.scrollIntoView = () => undefined;
  Element.prototype.scrollTo ??= () => undefined;
  vi.stubGlobal('scrollTo', () => undefined);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', {status: 404}))));
  // Each test's session leads alone: no queue messages from an earlier test's tab.
  vi.stubGlobal('BroadcastChannel', undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function note(id: number, issueId: number, status: string): Notification {
  return {id, user_id: 1, repo_id: 20, status, subject: 'issue', issue_id: issueId, comment_id: 0, actor_id: 3, created_at: T, updated_at: T};
}

function session(notes: Notification[]) {
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [
    {group: 'user:1', units: [], reason: 'self'}, {group: 'repo:20', units: [], reason: 'member'},
  ]}});
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'atlas'));
  s.data.put('Access', 'user:1', {id: 1, user_id: 1, repo_id: 20, permission: 'write'});
  s.data.put('Issue', 'repo:20', issue(100, 20, 7, 'Tiles from S3', {poster_id: 3}));
  s.data.put('Issue', 'repo:20', issue(101, 20, 8, 'cache: evict in a loop', {poster_id: 3, is_pull: true}));
  s.data.put('Issue', 'repo:20', issue(102, 20, 9, 'Beta feedback', {poster_id: 3}));
  for (const n of notes) s.data.put('Notification', 'user:1', n);
  return s;
}

async function open(path: string, s: Session, title: RegExp) {
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  await screen.findByRole('heading', {level: 1, name: title});
  return {app, router};
}

function statusIntents(app: AppState): Intent[] {
  return [...editing(app).intents.records.values()].map((r) => r.intent).filter((i) => i.kind.startsWith('notification.'));
}

function statusOf(app: AppState, id: number): string | undefined {
  const n = app.session?.data.pool.model('Notification').get(id);
  return n && notificationStatus(editing(app).overlay, n);
}

test('opening an issue by its address reads its unread notification, and only its', async () => {
  const s = session([note(1, 100, 'unread'), note(2, 102, 'unread')]);
  const {app} = await open('/acme/atlas/issues/7', s, /Tiles from S3/);
  await waitFor(() => {
    expect(statusIntents(app)).toEqual([expect.objectContaining({kind: 'notification.status', notificationId: 1, issueId: 100, status: 'read', base: 'unread'})]);
  });
  expect(statusOf(app, 1)).toBe('read');
  expect(statusOf(app, 2)).toBe('unread');
  expect(screen.getByRole('link', {name: /Inbox/}).textContent).toContain('1');
});

test('a pull request reads its notification on its Files tab too', async () => {
  const s = session([note(1, 101, 'unread')]);
  const {app} = await open('/acme/atlas/pulls/8?tab=files', s, /cache: evict in a loop/);
  await waitFor(() => {
    expect(statusOf(app, 1)).toBe('read');
  });
  expect(statusIntents(app)).toEqual([expect.objectContaining({kind: 'notification.status', notificationId: 1, issueId: 101, status: 'read'})]);
});

test('a pinned notification stays pinned when its issue is opened', async () => {
  const {app} = await open('/acme/atlas/issues/7', session([note(2, 100, 'pinned')]), /Tiles from S3/);
  await new Promise((r) => setTimeout(r, 20));
  expect(statusIntents(app)).toEqual([]);
  expect(statusOf(app, 2)).toBe('pinned');
});

test('a notification that arrives while the issue is open is read; one marked unread again is left so', async () => {
  const s = session([]);
  const {app} = await open('/acme/atlas/issues/7', s, /Tiles from S3/);
  expect(statusIntents(app)).toEqual([]);
  runInAction(() => {
    s.data.put('Notification', 'user:1', note(5, 100, 'unread'));
  });
  await waitFor(() => {
    expect(statusOf(app, 5)).toBe('read');
  });
  // Keep an explicit unread change while the page remains open.
  runInAction(() => {
    editing(app).intents.submit({kind: 'notification.status', notificationId: 5, issueId: 100, repoId: 20, status: 'unread', base: 'read'});
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(statusOf(app, 5)).toBe('unread');
});
