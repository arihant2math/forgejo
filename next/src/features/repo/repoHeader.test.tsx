// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


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

// jsdom has no Worker for the idle highlighter.
vi.spyOn(CodeSource.prototype, 'preheat').mockImplementation(() => undefined);
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
afterAll(() => new Promise<void>((resolve) => { setTimeout(resolve, 300); }));

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
const SHA = 'a'.repeat(40);

function branch(id: number, name: string): Branch {
  return {id, repo_id: 20, name, commit_id: SHA, commit_message: '', commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T};
}

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
const actionNames = [/^(Watch|Unwatch)/, /^Fork/, /^(Star|Starred)/];

describe('the repository header', () => {
  test('the home: the top row is owner / repository; Watch, Fork and Star follow the name in GitHub\'s order, without New issue', async () => {
    await open('/acme/website');
    const top = header();
    for (const name of actionNames) expect(within(top).queryByRole('button', {name})).toBeNull();
    const crumbs = within(top).getByRole('navigation', {name: 'Breadcrumb'});
    expect(within(crumbs).getAllByRole('link').map((a) => a.textContent)).toEqual(['acme', 'website']);
    const title = screen.getByRole('heading', {level: 2, name: /^website/});
    const buttons = actionNames.map((name) => screen.getByRole('button', {name}));
    for (const [i, b] of buttons.entries()) {
      expect(top.contains(b)).toBe(false);
      expect((buttons[i - 1] ?? title).compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByRole('button', {name: /^Star\s*\(12\)$/})).toBeTruthy();
    const body = title.closest<HTMLElement>('[data-scroll-restoration-id="page"]');
    if (!body) throw new Error('no page body');
    expect(within(body).queryByRole('button', {name: /^New issue/})).toBeNull();
  });

  for (const [what, path] of [
    ['issues', '/acme/website/issues'], ['pull requests', '/acme/website/pulls'], ['an issue', '/acme/website/issues/1'],
    ['settings', '/acme/website/settings'], ['activity', '/acme/website/activity'], ['labels', '/acme/website/labels'],
  ] as const) {
    test(`no repository actions on another page: ${what}`, async () => {
      await open(path);
      for (const name of actionNames) expect(screen.queryByRole('button', {name})).toBeNull();
    });
  }

  test('the issues creation action is primary and small', async () => {
    await open('/acme/website/issues');
    const action = screen.getByRole('button', {name: 'New issue'});
    expect(action.getAttribute('data-variant')).toBe('primary');
    expect(action.getAttribute('data-size')).toBe('small');
  });

  test('the pull request creation link keeps Primer sizing and its comparison destination', async () => {
    await open('/acme/website/pulls');
    const action = screen.getByRole('link', {name: 'New pull request'});
    expect(action.getAttribute('href')).toBe('/acme/website/compare');
    expect(action.getAttribute('data-variant')).toBe('primary');
    expect(action.getAttribute('data-size')).toBe('small');
  });

  test('the tabs: open counts after Issues and Pull requests; only the current tab is marked', async () => {
    const {container} = await open('/acme/website/issues');
    const tabs = screen.getByRole('navigation', {name: 'Repository'});
    const issues = within(tabs).getByRole('link', {name: /^Issues\s?\(2\)$/});
    expect(within(tabs).getByRole('link', {name: /^Pull requests\s?\(1\)$/})).toBeTruthy();
    expect(within(tabs).getByRole('link', {name: 'Code'})).toBeTruthy();
    expect(issues.getAttribute('aria-current')).toBe('page');
    expect(within(tabs).getAllByRole('link', {current: 'page'})).toEqual([issues]);
    expect(classConflicts(container)).toEqual([]);
  });

  for (const [what, path] of [['the home (no title row)', '/acme/website'], ['a page with a title row', '/acme/website/issues']] as const) {
    test(`the tabs row's divider runs on under More: ${what}`, async () => {
      await open(path);
      const tabs = screen.getByRole('navigation', {name: 'Repository'});
      const row = tabs.parentElement;
      if (!row) throw new Error('no tabs row');
      expect(row.classList).toContain('tabs-divider');
      const more = within(row).getByRole('button', {name: 'More of this repository'});
      expect(tabs.contains(more)).toBe(false);
      expect(tabs.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Inset geometry keeps the active underline on the divider without increasing row height.
      expect([...row.classList].filter((c) => c.startsWith('border'))).toEqual([]);
      expect(row.parentElement).toBe(header());
    });
  }
});
