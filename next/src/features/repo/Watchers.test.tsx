// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterAll, afterEach, describe, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {classConflicts} from '../../test/conflicts.ts';
import {fakeSession, repo, user} from '../../test/fakeSession.ts';
import {pageCount, type Watcher, WATCHERS_PER_PAGE} from './Watchers.tsx';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});
afterAll(() => new Promise<void>((resolve) => { setTimeout(resolve, 300); }));

const watcher = (id: number, login: string, extra: Partial<Watcher> = {}): Watcher =>
  ({id, login, full_name: '', avatar_url: '', website: '', location: '', created: '2024-03-05T10:00:00Z', ...extra});

/** acme/website (watched by `count`), with API v1 answering the subscribers by page. */
function setup(path: string, pages: Record<number, Watcher[]>, count: number) {
  const s = fakeSession({
    workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'user:1', units: [], reason: 'self'}, {group: 'repo:20', units: [], reason: 'member'}]},
  });
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website', {watchers_count: count}));
  s.auth.token = () => Promise.resolve('token');
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const u = new URL(url, 'http://localhost');
    calls.push(`${u.pathname}${u.search}`);
    if (u.pathname === '/api/v1/repos/acme/website/subscribers') {
      const page = Number(u.searchParams.get('page'));
      return Promise.resolve(new Response(JSON.stringify(pages[page] ?? []), {headers: {'Content-Type': 'application/json', 'X-Total-Count': String(count)}}));
    }
    return Promise.resolve(new Response('null', {headers: {'Content-Type': 'application/json'}}));
  }));
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  return {s, app, router, calls};
}

describe('a repository\'s watchers (#255)', () => {
  test('the app\'s page at the classic address: each watcher\'s card (website, else location, else when they joined), their profile', async () => {
    const {app, router, calls} = setup('/acme/website/watchers', {
      1: [
        watcher(3, 'bob', {full_name: 'Bob Builder', website: 'https://bob.example/', location: 'Paris'}),
        watcher(4, 'carol', {location: 'Lyon'}),
        watcher(5, 'dave'),
      ],
    }, 3);
    await router.load();
    const {container} = render(<App app={app} router={router}/>);
    const panel = await screen.findByRole('region', {name: 'Watchers'});
    // Not the not-found page, and the page's title.
    expect(screen.queryByText(/not found/i)).toBeNull();
    expect(document.title).toContain('Watchers · acme/website');
    expect(within(panel).getByRole('banner').textContent).toBe('Watchers3');
    const bob = await within(panel).findByRole('link', {name: 'Bob Builder'});
    expect(bob.getAttribute('href')).toBe('/bob');
    expect(within(panel).getByText('bob')).toBeTruthy();
    // The website only, as the classic card.
    const site = within(panel).getByRole('link', {name: 'https://bob.example/'});
    expect(site.getAttribute('target')).toBe('_blank');
    expect(within(panel).queryByText('Paris')).toBeNull();
    expect(within(panel).getByRole('link', {name: 'carol'}).getAttribute('href')).toBe('/carol');
    expect(within(panel).getByText('Lyon')).toBeTruthy();
    const dave = within(panel).getByRole('link', {name: 'dave'}).closest('li');
    expect(dave?.textContent).toMatch(/daveJoined Mar 5, 2024$/);
    expect(dave?.querySelector('time')?.getAttribute('dateTime')).toBe('2024-03-05T10:00:00Z');
    // One page: no pagination.
    expect(within(panel).queryByRole('navigation', {name: 'Pages'})).toBeNull();
    expect(calls).toContain(`/api/v1/repos/acme/website/subscribers?limit=${String(WATCHERS_PER_PAGE)}&page=1`);
    expect(classConflicts(container)).toEqual([]);
  });

  test('a page at a time (`?page=`, the classic pagination), Forgejo\'s total says how many pages', async () => {
    const many = (from: number, n: number) => Array.from({length: n}, (_, i) => watcher(from + i, `user${String(from + i)}`));
    const total = 2 * WATCHERS_PER_PAGE + 5;
    const {app, router, calls} = setup('/acme/website/watchers', {1: many(100, WATCHERS_PER_PAGE), 2: many(200, WATCHERS_PER_PAGE), 3: many(300, 5)}, total);
    await router.load();
    render(<App app={app} router={router}/>);
    const panel = await screen.findByRole('region', {name: 'Watchers'});
    await within(panel).findByRole('link', {name: 'user100'});
    const pages = within(panel).getByRole('navigation', {name: 'Pages'});
    expect(pages.textContent).toContain('Page 1 of 3');
    expect((within(pages).getByRole('button', {name: 'Previous'}) as HTMLButtonElement).disabled).toBe(true);
    const next = within(pages).getByRole('link', {name: 'Next'});
    expect(next.getAttribute('href')).toBe('/acme/website/watchers?page=2');
    fireEvent.click(next);
    await within(panel).findByRole('link', {name: 'user200'});
    expect(router.state.location.searchStr).toBe('?page=2');
    fireEvent.click(within(within(panel).getByRole('navigation', {name: 'Pages'})).getByRole('link', {name: 'Next'}));
    await within(panel).findByRole('link', {name: 'user300'});
    const last = within(panel).getByRole('navigation', {name: 'Pages'});
    expect(last.textContent).toContain('Page 3 of 3');
    expect((within(last).getByRole('button', {name: 'Next'}) as HTMLButtonElement).disabled).toBe(true);
    expect(within(last).getByRole('link', {name: 'Previous'}).getAttribute('href')).toBe('/acme/website/watchers?page=2');
    expect(calls.filter((c) => c.includes('/subscribers')).map((c) => new URL(c, 'http://localhost').searchParams.get('page'))).toEqual(['1', '2', '3']);
  });

  test('nobody watching; and the list is asked again when the count changes (the header\'s Watch)', async () => {
    const {s, app, router, calls} = setup('/acme/website/watchers', {}, 0);
    await router.load();
    render(<App app={app} router={router}/>);
    const panel = await screen.findByRole('region', {name: 'Watchers'});
    expect(await within(panel).findByText('Nobody is watching this repository.')).toBeTruthy();
    const asked = () => calls.filter((c) => c.includes('/subscribers')).length;
    const before = asked();
    act(() => {
      s.data.put('Repository', 'repo:20', repo(20, user(2, 'acme', 'organization'), 'website', {watchers_count: 1}));
    });
    await waitFor(() => { expect(asked()).toBe(before + 1); });
  });

  test('how many pages a total fills', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(WATCHERS_PER_PAGE)).toBe(1);
    expect(pageCount(WATCHERS_PER_PAGE + 1)).toBe(2);
  });
});
