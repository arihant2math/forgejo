// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {cleanup, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp, type Session} from '../../app/store.ts';
import {IntentDb} from '../../intents/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {comment, fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

let scrolled: Element[] = [];
beforeEach(() => {
  scrolled = [];
  // jsdom has no layout: record what is scrolled into view.
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    scrolled.push(this);
  };
  Element.prototype.scrollTo ??= () => undefined;
  // API v1 (the viewer's permissions) is not asked here: the pool's access rows decide.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', {status: 404}))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Alice (1) on acme/website (20, an organization's) with `permission`, and its issue #7 (100). */
function session(permission: string, comments = 0) {
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'member'}]}});
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  s.data.put('Access', 'user:1', {id: 1, user_id: 1, repo_id: 20, permission});
  s.data.put('Issue', 'repo:20', issue(100, 20, 7, 'Footer links are broken', {poster_id: 3, comments}));
  for (let i = 1; i <= comments; i++) {
    const at = new Date(Date.parse(T) + i * 60_000).toISOString();
    s.data.put('Comment', 'issue:100', comment(1000 + i, 100, `Comment number ${String(i)}`, {poster_id: 3, created_at: at, updated_at: at}));
  }
  return s;
}

async function open(path: string, s: Session) {
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  await screen.findByRole('heading', {level: 1, name: /Footer links are broken/});
  return {app, router};
}

test('a writer who is not an administrator sees the pin state and why it cannot be changed (#226)', async () => {
  await open('/acme/website/issues/7', session('write'));
  expect(await screen.findByText('Only repository administrators can pin issues.')).toBeTruthy();
  expect(screen.getByText('Not pinned')).toBeTruthy();
  expect(screen.queryByRole('button', {name: /Not pinned/})).toBeNull();
  // Locking stays a writer's.
  expect(screen.getByRole('button', {name: /Open to comments/})).toBeTruthy();
});

test('an administrator can pin (#226)', async () => {
  await open('/acme/website/issues/7', session('admin'));
  expect(await screen.findByRole('button', {name: /Not pinned/})).toBeTruthy();
  expect(screen.queryByText('Only repository administrators can pin issues.')).toBeNull();
});

test('a comment permalink scrolls to the comment and highlights it, also past the first painted items (#210)', async () => {
  await open('/acme/website/issues/7#comment-1025', session('read', 30));
  await waitFor(() => {
    expect(scrolled.map((e) => e.id)).toContain('comment-1025');
  });
  const card = document.getElementById('comment-1025');
  expect(card?.getAttribute('aria-current')).toBe('location');
  expect(document.querySelectorAll('[aria-current="location"]')).toHaveLength(1);
});

test('classic Forgejo\'s #issuecomment- permalinks work too, and an unknown comment scrolls nowhere (#210)', async () => {
  await open('/acme/website/issues/7#issuecomment-1003', session('read', 5));
  await waitFor(() => {
    expect(scrolled.map((e) => e.id)).toContain('comment-1003');
  });
  cleanup();
  scrolled = [];
  await open('/acme/website/issues/7#comment-999', session('read', 5));
  await screen.findByText('Comment number 5', {exact: false}).catch(() => undefined);
  expect(scrolled.filter((e) => e.id.startsWith('comment-'))).toEqual([]);
});

test('a comment draft kept in IndexedDB is back in the comment box even when the page opens before the drafts are read (#193)', async () => {
  const s = session('write');
  await new IntentDb(s.data.db).putDraft({key: 'text:new-comment:100', kind: 'text', title: 'A new comment', issueId: 100, repoId: 20, text: 'Half-written reply', at: Date.now()});
  await open('/acme/website/issues/7', s);
  await waitFor(() => {
    const box = screen.getByRole('textbox', {name: 'Leave a comment'});
    expect(box instanceof HTMLTextAreaElement ? box.value : box.textContent).toBe('Half-written reply');
  });
});

test('a long (virtualized) timeline brings the linked comment into view (#210)', async () => {
  await open('/acme/website/issues/7#comment-1055', session('read', 60));
  await waitFor(() => {
    expect(scrolled.map((e) => e.id)).toContain('comment-1055');
  }, {timeout: 4000});
});
