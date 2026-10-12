// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, user} from '../../test/fakeSession.ts';
import {type WikiPageMeta, type WikiPageRecord, WikiSource, wikiSource} from './data.ts';

vi.spyOn(WikiSource.prototype, 'loadList').mockResolvedValue(undefined);
vi.spyOn(WikiSource.prototype, 'loadPage').mockResolvedValue(undefined);

afterEach(() => {
  localStorage.clear();
});

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

function meta(name: string): WikiPageMeta {
  return {name, title: name.replaceAll('-', ' '), sha: '', date: '', author: ''};
}

async function renderWiki(count: number, sidebar: string | null) {
  const me = user(1, 'alice');
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'owner'}]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('Repository', 'repo:20', repo(20, me, 'website'));
  const app = createApp(config, s);
  const src = wikiSource(app);
  if (!src) throw new Error('no wiki source');
  const pages = [meta('Home'), ...Array.from({length: count - 1}, (_, i) => meta(`Page-${String(i + 1).padStart(2, '0')}`))];
  const rec: WikiPageRecord = {name: 'Home', title: 'Home', sha: '', author: '', date: '', message: '', commitCount: 0, text: '', html: '<p>Welcome</p>', sidebar: sidebar === null ? null : {text: sidebar, html: `<p>${sidebar}</p>`}, footer: null};
  const cache = (src as unknown as {cache: {put: (k: string, v: unknown) => void}}).cache;
  cache.put(WikiSource.listKey(20), {kind: 'pages', pages});
  cache.put(WikiSource.pageKey(20, 'Home'), rec);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/alice/website/wiki/Home']}));
  await router.load();
  render(<App app={app} router={router}/>);
  return screen.findByRole('complementary', {name: 'Wiki'});
}

describe('the wiki page', () => {
  test('Edit and New page (primary) in the header; no Pages button', async () => {
    await renderWiki(3, null);
    const header = document.querySelector('header');
    if (!header) throw new Error('no header');
    expect(within(header).getByRole('link', {name: 'Edit'}).getAttribute('data-variant')).toBe('default');
    expect(within(header).getByRole('link', {name: 'New page'}).getAttribute('data-variant')).toBe('primary');
    expect(within(header).queryByRole('link', {name: 'Pages'})).toBeNull();
  });

  test('the side: Pages first with a filter and Show more, then the custom sidebar with its Edit', async () => {
    const aside = await renderWiki(45, 'Custom links');
    const nav = within(aside).getByRole('navigation', {name: 'Pages'});
    const sidebar = within(aside).getByRole('region', {name: 'Wiki sidebar'});
    expect(nav.compareDocumentPosition(sidebar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sidebar).getByText('Custom links')).toBeTruthy();
    expect(within(sidebar).getByRole('link', {name: 'Edit the sidebar'}).getAttribute('href')).toBe('/alice/website/wiki/_Sidebar/-/edit');
    expect(within(nav).getAllByRole('link')).toHaveLength(40);
    expect(within(nav).getByRole('link', {name: 'Home'}).getAttribute('aria-current')).toBe('page');
    fireEvent.click(within(nav).getByRole('button', {name: 'Show 5 more pages…'}));
    expect(within(nav).getAllByRole('link')).toHaveLength(45);
    expect(within(nav).getByRole('link', {name: 'Page 44'}).getAttribute('href')).toBe('/alice/website/wiki/Page-44');
    fireEvent.change(within(aside).getByRole('textbox', {name: 'Find a page'}), {target: {value: 'page 4'}});
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Page 40', 'Page 41', 'Page 42', 'Page 43', 'Page 44']);
    expect(within(nav).queryByRole('button', {name: /^Show/})).toBeNull();
  });
});
