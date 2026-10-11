// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The repository header as GitHub's (#252): owner / repository on top, the tabs (open counts after Issues and Pull
// requests, the current one underlined), and the repository's actions (Star, Watch, Fork, New issue) on its home
// only, in the home's title row.

import {createMemoryHistory} from '@tanstack/react-router';
import {render, screen, within} from '@testing-library/react';
import {afterAll, afterEach, describe, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {CodeSource} from '../../code/source.ts';
import type {Branch, NextConfig} from '../../protocol/types.gen.ts';
import {classConflicts} from '../../test/conflicts.ts';
import {fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';

// The file list warms the highlighter when idle: jsdom has no Worker.
vi.spyOn(CodeSource.prototype, 'preheat').mockImplementation(() => undefined);
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
afterAll(() => new Promise<void>((resolve) => { setTimeout(resolve, 300); }));

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
const SHA = 'a'.repeat(40);

function branch(id: number, name: string): Branch {
  return {id, repo_id: 20, name, commit_id: SHA, commit_message: '', commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T};
}

/** alice administers acme/website: 2 open issues, 1 closed, 1 open pull request. */
async function open(path: string) {
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'owner'}]}});
  const me = user(1, 'alice');
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'profile:1', me);
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website', {stars_count: 12, watchers_count: 3, forks_count: 1}));
  s.data.put('Branch', 'repo:20', branch(1, 'main'));
  s.data.put('Issue', 'repo:20', issue(100, 20, 1, 'First'));
  s.data.put('Issue', 'repo:20', issue(101, 20, 2, 'Second'));
  s.data.put('Issue', 'repo:20', issue(102, 20, 3, 'Done', {state: 'closed', closed_at: T}));
  s.data.put('Issue', 'repo:20', issue(103, 20, 4, 'A change', {is_pull: true}));
  s.auth.token = () => Promise.resolve('token');
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', {status: 404, headers: {'Content-Type': 'application/json'}}))));
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  const r = render(<App app={app} router={router}/>);
  await screen.findByRole('navigation', {name: 'Breadcrumb'});
  return {s, ...r};
}

const header = () => {
  const h = document.querySelector('header');
  if (!h) throw new Error('no header');
  return h;
};
const actionNames = [/^(Star|Unstar)/, /^Watch/, /^Fork/, /^New issue/];

describe('the repository header', () => {
  test('the home: the top row is owner / repository; Star, Watch, Fork and New issue are in the title row', async () => {
    await open('/acme/website');
    const top = header();
    for (const name of actionNames) expect(within(top).queryByRole('button', {name})).toBeNull();
    const crumbs = within(top).getByRole('navigation', {name: 'Breadcrumb'});
    expect(within(crumbs).getAllByRole('link').map((a) => a.textContent)).toEqual(['acme', 'website']);
    // The title row: the repository's name and its actions, in the page's body.
    const title = screen.getByRole('heading', {level: 2, name: /^website/});
    const row = title.parentElement;
    if (!row) throw new Error('no title row');
    for (const name of actionNames) expect(within(row).getByRole('button', {name})).toBeTruthy();
    // The counts are still the live ones (#202).
    expect(within(row).getByRole('button', {name: /^(Star|Unstar)/}).textContent).toMatch(/12$/);
    expect(top.contains(row)).toBe(false);
  });

  for (const [what, path] of [
    ['issues', '/acme/website/issues'], ['pull requests', '/acme/website/pulls'], ['an issue', '/acme/website/issues/1'],
    ['settings', '/acme/website/settings'], ['activity', '/acme/website/activity'], ['labels', '/acme/website/labels'],
  ] as const) {
    test(`no repository actions on another page: ${what}`, async () => {
      await open(path);
      for (const name of actionNames.slice(0, 3)) expect(screen.queryByRole('button', {name})).toBeNull();
    });
  }

  test('the tabs: open counts after Issues and Pull requests; the current tab underlined, not filled', async () => {
    const {container} = await open('/acme/website/issues');
    const tabs = screen.getByRole('navigation', {name: 'Repository'});
    const issues = within(tabs).getByRole('link', {name: /^Issues\s?2$/});
    expect(within(tabs).getByRole('link', {name: /^Pull requests\s?1$/})).toBeTruthy();
    expect(within(tabs).getByRole('link', {name: 'Code'})).toBeTruthy();
    expect(issues.getAttribute('aria-current')).toBe('page');
    expect(issues.className).toContain('aria-[current=page]:after:bg-accent-emphasis');
    expect(issues.className).not.toContain('bg-control-transparent-selected');
    expect(classConflicts(container)).toEqual([]);
  });
});
