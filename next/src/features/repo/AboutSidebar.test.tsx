// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {CodeSource, codeSource} from '../../code/source.ts';
import type {APITree, Branch, NextConfig, Release, Repository} from '../../protocol/types.gen.ts';
import {classConflicts} from '../../test/conflicts.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';

// jsdom has no Worker for the idle highlighter.
vi.spyOn(CodeSource.prototype, 'preheat').mockImplementation(() => undefined);

afterEach(() => {
  localStorage.clear();
});

const SHA = 'a'.repeat(40);

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

function branch(id: number, repoId: number, name: string, commit: string): Branch {
  return {id, repo_id: repoId, name, commit_id: commit, commit_message: '', commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T};
}

function release(id: number, tag: string, created: string, extra: Partial<Release> = {}): Release {
  return {
    id, repo_id: 20, publisher_id: 1, tag_name: tag, target_commitish: 'main', name: '', sha: String(id).padStart(40, '0'), body: '', body_html: '',
    draft: false, prerelease: false, is_tag: false, num_commits: 0, hide_archive_links: false, original_author: '', created_at: created, ...extra,
  };
}

function session(extra: Partial<Repository> = {}, opts: {tree?: boolean; releases?: boolean; languages?: Record<string, number>} = {}) {
  const me = user(1, 'alice');
  const acme = user(2, 'acme', 'organization');
  const s = fakeSession({
    workspace: {
      viewer_id: 1, truncated: false, max_repos: 200,
      groups: [{group: 'user:1', units: [], reason: 'self'}, {group: 'org:2', units: [], reason: 'member'}, {group: 'repo:20', units: [], reason: 'member'}, {group: 'repo:22', units: [], reason: 'member'}],
    },
  });
  s.data.put('User', 'profile:1', me);
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:22', repo(22, acme, 'upstream'));
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website', {
    description: 'The public website.', website: 'https://example.com/', topics: ['web', 'docs'],
    stars_count: 12, watchers_count: 3, forks_count: 1, fork: true, parent_id: 22, ...extra,
  }));
  s.data.put('Branch', 'repo:20', branch(1, 20, 'main', SHA));
  if (opts.releases === false) return {s, opts};
  s.data.put('Release', 'repo:20', release(1, 'v1.0.0', '2026-01-01T00:00:00Z', {name: 'First'}));
  s.data.put('Release', 'repo:20', release(2, 'v1.1.0', '2026-03-01T00:00:00Z', {name: 'Second'}));
  s.data.put('Release', 'repo:20', release(3, 'v2.0.0-rc1', '2026-05-01T00:00:00Z', {prerelease: true}));
  s.data.put('Release', 'repo:20', release(4, 'v0.9', '2025-12-01T00:00:00Z', {is_tag: true}));
  return {s, opts};
}

async function renderHome({s, opts}: ReturnType<typeof session>) {
  const app = createApp(config, s);
  const src = codeSource(app);
  if (!src) throw new Error('no code source');
  if (opts.tree !== false) {
    const tree: APITree = {commit: SHA, path: '', sha: 'b'.repeat(40), entries: [
      {name: 'LICENSE', type: 'blob', mode: '100644', sha: 'c'.repeat(40), size: 1000},
      {name: 'README.md', type: 'blob', mode: '100644', sha: 'd'.repeat(40), size: 100},
      {name: 'src', type: 'tree', mode: '040000', sha: 'e'.repeat(40)},
    ]};
    src.cache.put(CodeSource.treeKey(20, SHA, ''), tree);
  }
  if (opts.languages) src.cache.put(CodeSource.languagesKey(20, SHA), opts.languages);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/acme/website']}));
  await router.load();
  const r = render(<App app={app} router={router}/>);
  const pane = await screen.findByRole('complementary', {name: 'About'});
  return {app, router, pane, ...r};
}

describe('the repository home\'s side pane', () => {
  test('About: description, website, topics, fork parent, Readme / License / Activity, counts (the clone URL and archives are in the Code menu)', async () => {
    const {pane} = await renderHome(session({}, {languages: {Go: 750, TypeScript: 250}}));
    const about = within(pane).getByRole('region', {name: 'About'});
    expect(within(about).getByText('The public website.')).toBeTruthy();
    expect(screen.getAllByText('The public website.')).toHaveLength(1);
    const site = within(about).getByRole('link', {name: 'example.com'});
    expect(site.getAttribute('href')).toBe('https://example.com/');
    expect(site.getAttribute('target')).toBe('_blank');
    expect(within(within(about).getByRole('list', {name: 'Topics'})).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['web', 'docs']);
    expect(within(about).getByRole('link', {name: 'acme/upstream'}).getAttribute('href')).toBe('/acme/upstream');
    const links = within(about).getByRole('list', {name: 'Repository'});
    expect(within(links).getAllByRole('link').map((a) => a.textContent)).toEqual(['Readme', 'View license', 'Activity', '12 stars', '3 watching', '1 fork']);
    expect(within(links).getByRole('link', {name: 'Readme'}).getAttribute('href')).toBe('#readme');
    expect(within(links).getByRole('link', {name: 'View license'}).getAttribute('href')).toBe('/acme/website/src/branch/main/LICENSE');
    for (const [name, path] of [['Activity', 'activity'], ['3 watching', 'watchers']] as const) {
      const a = within(links).getByRole('link', {name});
      expect(a.getAttribute('href')).toBe(`/acme/website/${path}`);
      expect(a.hasAttribute('data-classic')).toBe(false);
    }
    for (const [name, path] of [['12 stars', 'stars'], ['1 fork', 'forks']] as const) {
      const a = within(links).getByRole('link', {name});
      expect(a.getAttribute('href')).toBe(`/acme/website/${path}`);
      expect(a.hasAttribute('data-classic')).toBe(true);
    }
    expect(within(about).queryByRole('button', {name: 'Copy the clone URL'})).toBeNull();
    expect(within(about).queryByRole('link', {name: 'Download ZIP'})).toBeNull();
    expect(within(pane).queryByText(/\d+ open/)).toBeNull();
    expect(document.getElementById('readme')?.getAttribute('aria-label')).toBe('README');
    expect(classConflicts(pane)).toEqual([]);
  });

  test('Releases: the count, the latest (not a pre-release) and the rest; Tags with its count; both lead to their views', async () => {
    const {pane} = await renderHome(session());
    const rel = within(pane).getByRole('region', {name: 'Releases'});
    expect(within(rel).getByRole('heading').textContent).toBe('Releases');
    expect(within(rel).getByText('3', {selector: '[data-component="CounterLabel"]'})).toBeTruthy();
    expect(within(rel).getByRole('link', {name: 'Releases'}).getAttribute('href')).toBe('/acme/website/releases');
    const latest = within(rel).getByRole('link', {name: /Second/});
    expect(latest.textContent).toContain('Latest');
    expect(latest.getAttribute('href')).toBe('/acme/website/releases');
    expect(within(rel).getByRole('link', {name: '+ 2 releases'}).getAttribute('href')).toBe('/acme/website/releases');
    expect(within(rel).getByRole('link', {name: '4 tags'}).getAttribute('href')).toBe('/acme/website/tags');
  });

  test('Languages: the bar and its legend from the code cache, largest first', async () => {
    const {pane} = await renderHome(session({}, {languages: {TypeScript: 250, Go: 750}}));
    const langs = within(pane).getByRole('region', {name: 'Languages'});
    const legend = within(within(langs).getByRole('list', {name: 'Language shares'})).getAllByRole('listitem').map((li) => li.textContent);
    expect(legend).toEqual(['Go 75.0%', 'TypeScript 25.0%']);
  });

  test('the description shows its emoji shortcodes as emoji, as plain text in the same paragraph (#269)', async () => {
    const description = ':cherry_blossom: A command-line fuzzy finder — QA mirror of junegunn/fzf :unknown_code: <b>x</b>';
    const {pane, app} = await renderHome(session({description}));
    const about = within(pane).getByRole('region', {name: 'About'});
    const p = within(about).getByText(/A command-line fuzzy finder/);
    expect(p.tagName).toBe('P');
    expect(p.className).toBe('text-base text-default');
    expect(p.textContent).toBe('🌸 A command-line fuzzy finder — QA mirror of junegunn/fzf :unknown_code: <b>x</b>');
    expect(p.children).toHaveLength(0);
    expect(app.session?.data.pool.model('Repository').get(20)?.get('description')).toBe(description);
  });

  test('nothing known yet: no Languages section, no Readme or License; nothing provided says so; no releases', async () => {
    const {pane} = await renderHome(session({description: '', website: '', topics: [], fork: false, parent_id: 0}, {tree: false, releases: false}));
    expect(within(pane).queryByRole('region', {name: 'Languages'})).toBeNull();
    const about = within(pane).getByRole('region', {name: 'About'});
    expect(within(about).getByText('No description, website, or topics provided.')).toBeTruthy();
    expect(within(about).queryByRole('link', {name: 'Readme'})).toBeNull();
    expect(within(about).queryByText(/Forked from/)).toBeNull();
    const rel = within(pane).getByRole('region', {name: 'Releases'});
    expect(within(rel).getByText('No releases published.')).toBeTruthy();
    expect(within(rel).queryByRole('link')).toBeNull();
  });

  test('one changed count re-renders its own line', async () => {
    const parts = session();
    const {pane} = await renderHome(parts);
    const links = within(pane).getByRole('list', {name: 'Repository'});
    const stars = within(links).getByRole('link', {name: '12 stars'});
    act(() => {
      parts.s.data.put('Repository', 'repo:20', repo(20, user(2, 'acme', 'organization'), 'website', {
        description: 'The public website.', website: 'https://example.com/', topics: ['web', 'docs'],
        stars_count: 13, watchers_count: 3, forks_count: 1, fork: true, parent_id: 22,
      }));
    });
    expect(stars.textContent).toBe('13 stars');
  });
});

describe('the header\'s Star and Watch buttons', () => {
  test('show the About counts and follow them live (#202)', async () => {
    const parts = session();
    await renderHome(parts);
    const star = screen.getByRole('button', {name: /^(Star|Unstar)/});
    const watch = screen.getByRole('button', {name: /^(Watch|Watching)/});
    expect(star.querySelector('[data-component="ButtonCounter"]')?.textContent).toBe('12');
    expect(watch.querySelector('[data-component="ButtonCounter"]')?.textContent).toBe('3');
    act(() => {
      parts.s.data.put('Repository', 'repo:20', repo(20, user(2, 'acme', 'organization'), 'website', {
        description: 'The public website.', stars_count: 11, watchers_count: 4, forks_count: 1, fork: true, parent_id: 22,
      }));
    });
    expect(star.querySelector('[data-component="ButtonCounter"]')?.textContent).toBe('11');
    expect(watch.querySelector('[data-component="ButtonCounter"]')?.textContent).toBe('4');
  });

  test('a releases-only watch is shown as such, never as "All activity"; releases are said to come by email (#198, #201)', async () => {
    const parts = session();
    parts.s.auth.token = () => Promise.resolve('token');
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const path = new URL(url, 'http://localhost').pathname;
      const status = path.endsWith('/subscription') ? 200 : 404;
      return Promise.resolve(new Response(status === 200 ? JSON.stringify({subscribed: true}) : '{}', {status, headers: {'Content-Type': 'application/json'}}));
    }));
    try {
      parts.s.data.put('Watch', 'user:1', {id: 1, user_id: 1, repo_id: 20, automatic: false, issues: false, pull_requests: false, releases: true, created_at: T, updated_at: T});
      await renderHome(parts);
      const watch = screen.getByRole('button', {name: /^Watching/});
      expect(watch.querySelector('[data-component="ButtonCounter"]')?.textContent).toBe('3');
      await waitFor(() => { expect((watch as HTMLButtonElement).disabled).toBe(false); });
      fireEvent.click(watch);
      const custom = await screen.findByRole('menuitem', {name: /^Custom: releases ✓/});
      expect(custom.getAttribute('href')).toBe('/acme/website?ui=classic');
      expect(screen.getByRole('menuitemradio', {name: 'All activity'})).toBeTruthy();
      expect(screen.getByRole('menuitemradio', {name: 'Participating and mentions'})).toBeTruthy();
      expect(screen.getByText(/New releases are announced by email only/)).toBeTruthy();
    } finally { vi.unstubAllGlobals(); }
  });
});
