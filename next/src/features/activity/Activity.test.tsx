// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {render, screen, within} from '@testing-library/react';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {CodeSource} from '../../code/source.ts';
import type {Branch, NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';

// Hover prefetch must not reach the network in these tests.
vi.spyOn(CodeSource.prototype, 'contributors').mockImplementation(() => new Promise(() => undefined));
vi.spyOn(CodeSource.prototype, 'commitActivity').mockImplementation(() => new Promise(() => undefined));

afterEach(() => {
  localStorage.clear();
});

const SHA = 'a'.repeat(40);

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

function branch(id: number, repoId: number, name: string, commit: string): Branch {
  return {id, repo_id: repoId, name, commit_id: commit, commit_message: '', commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T};
}

function session() {
  const acme = user(2, 'acme', 'organization');
  const s = fakeSession({
    workspace: {
      viewer_id: 1, truncated: false, max_repos: 200,
      groups: [{group: 'user:1', units: [], reason: 'self'}, {group: 'org:2', units: [], reason: 'member'}, {group: 'repo:20', units: [], reason: 'member'}],
    },
  });
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  s.data.put('Branch', 'repo:20', branch(1, 20, 'main', SHA));
  return s;
}

async function renderActivity(path: string) {
  const app = createApp(config, session());
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return screen.findByRole('navigation', {name: 'Activity pages'});
}

describe('the activity side list', () => {
  test.each([
    ['/acme/website/activity', 'Pulse'],
    ['/acme/website/activity/monthly', 'Pulse'],
    ['/acme/website/activity/code-frequency', 'Code frequency'],
    ['/acme/website/activity/recent-commits', 'Commits'],
  ])('on %s: GitHub\'s order and labels, plain links, only the current page marked', async (path, current) => {
    const nav = await renderActivity(path);
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['Pulse', 'Contributors', 'Commits', 'Code frequency']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/acme/website/activity', '/acme/website/activity/contributors', '/acme/website/activity/recent-commits', '/acme/website/activity/code-frequency',
    ]);
    expect(within(nav).getAllByRole('link', {current: 'page'}).map((a) => a.textContent)).toEqual([current]);
    expect(links.every((a) => a.querySelector('svg') === null)).toBe(true);
  });
});
