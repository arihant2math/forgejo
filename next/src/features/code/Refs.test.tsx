// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig, Repository} from '../../protocol/types.gen.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';

const MAIN = 'a'.repeat(40);

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const branch = (id: number, name: string, sha: string) => ({
  id, repo_id: 20, name, commit_id: sha, commit_message: `${name} head`, commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T,
});

const tag = (id: number, name: string, sha: string, extra = {}) => ({
  id, repo_id: 20, publisher_id: 1, tag_name: name, target_commitish: 'main', name: '', sha, body: '', body_html: '', draft: false, prerelease: false, is_tag: true,
  num_commits: 1, hide_archive_links: false, original_author: '', created_at: T, ...extra,
});

function session(extra: Partial<Repository> = {}) {
  const me = user(1, 'alice');
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'owner'}]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('Repository', 'repo:20', repo(20, me, 'website', extra));
  s.data.put('Branch', 'repo:20', branch(1, 'main', MAIN));
  s.data.put('Release', 'repo:20', tag(5, 'v1.0', MAIN));
  s.auth.token = () => Promise.resolve('token');
  s.data.whenSynced = () => Promise.resolve();
  return s;
}

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

function stubForgejo(answer: (method: string, url: string, body: unknown) => {status: number; json: unknown} | undefined): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : init?.body;
    if (method !== 'GET') sent.push({method, url, body});
    const a = answer(method, url, body) ?? {status: 404, json: {message: 'not here'}};
    return Promise.resolve(new Response(a.json === undefined ? null : JSON.stringify(a.json), {status: a.status, headers: {'Content-Type': 'application/json', 'X-Livesync-Sync-Id': '40'}}));
  }));
  return sent;
}

async function open(app: ReturnType<typeof createApp>, path: string) {
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return router;
}

test('a new branch from a tag: API v1 is asked, the dialog closes once the pool has the branch', async () => {
  const s = session();
  const sent = stubForgejo((method, url) => {
    if (method === 'POST' && url.endsWith('/api/v1/repos/alice/website/branches')) {
      setTimeout(() => {
        s.data.put('Branch', 'repo:20', branch(2, 'fix/footer', MAIN));
      }, 10);
      return {status: 201, json: {name: 'fix/footer'}};
    }
    return undefined;
  });
  const app = createApp(config, s);
  await open(app, '/alice/website/branches');
  fireEvent.click(await screen.findByRole('button', {name: 'New branch'}));
  const dialog = await screen.findByRole('dialog', {name: 'New branch'});
  const name = within(dialog).getByRole('textbox', {name: 'Branch name'});
  fireEvent.change(name, {target: {value: 'fix footer'}});
  expect(within(dialog).getByRole('alert').textContent).toMatch(/Spaces/);
  fireEvent.change(name, {target: {value: 'main'}});
  expect(within(dialog).getByRole('alert').textContent).toMatch(/exists already/);
  fireEvent.change(name, {target: {value: 'fix/footer'}});
  fireEvent.click(within(dialog).getByRole('button', {name: 'Start from: main'}));
  fireEvent.click(await screen.findByRole('option', {name: /v1\.0/}));
  act(() => {
    fireEvent.click(within(dialog).getByRole('button', {name: 'Create branch'}));
  });
  await waitFor(() => {
    expect(screen.queryByRole('dialog', {name: 'New branch'})).toBeNull();
  });
  expect(sent).toEqual([{method: 'POST', url: '/api/v1/repos/alice/website/branches', body: {new_branch_name: 'fix/footer', old_ref_name: 'v1.0'}}]);
  expect([...s.data.pool.model('Branch').by('repo_id', 20)].map((b) => b.get('name')).sort()).toEqual(['fix/footer', 'main']);
});

test('a new annotated tag; Forgejo\'s refusal stays in the dialog', async () => {
  const s = session();
  let refuse = true;
  const sent = stubForgejo((method, url) => {
    if (method === 'POST' && url.endsWith('/tags')) {
      if (refuse) return {status: 422, json: {message: 'user not allowed to create protected tag'}};
      setTimeout(() => {
        s.data.put('Release', 'repo:20', tag(6, 'v2.0', MAIN));
      }, 10);
      return {status: 201, json: {name: 'v2.0'}};
    }
    return undefined;
  });
  const app = createApp(config, s);
  await open(app, '/alice/website/tags');
  fireEvent.click(await screen.findByRole('button', {name: 'New tag'}));
  const dialog = await screen.findByRole('dialog', {name: 'New tag'});
  fireEvent.change(within(dialog).getByRole('textbox', {name: 'Tag name'}), {target: {value: 'v2.0'}});
  fireEvent.change(within(dialog).getByRole('textbox', {name: 'Message'}), {target: {value: 'The second one'}});
  act(() => {
    fireEvent.click(within(dialog).getByRole('button', {name: 'Create tag'}));
  });
  expect(await within(dialog).findByText('user not allowed to create protected tag')).toBeTruthy();
  refuse = false;
  act(() => {
    fireEvent.click(within(dialog).getByRole('button', {name: 'Create tag'}));
  });
  await waitFor(() => {
    expect(screen.queryByRole('dialog', {name: 'New tag'})).toBeNull();
  });
  expect(sent.map((x) => x.body)).toEqual([
    {tag_name: 'v2.0', target: 'main', message: 'The second one'},
    {tag_name: 'v2.0', target: 'main', message: 'The second one'},
  ]);
});

test('an archived repository: the dialog says why, nothing is sent', async () => {
  const s = session({archived: true});
  const sent = stubForgejo(() => undefined);
  const app = createApp(config, s);
  await open(app, '/alice/website/branches');
  fireEvent.click(await screen.findByRole('button', {name: 'New branch'}));
  const dialog = await screen.findByRole('dialog', {name: 'New branch'});
  expect(within(dialog).getByText(/archived/)).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('textbox', {name: 'Branch name'}), {target: {value: 'x'}});
  const create = within(dialog).getByRole('button', {name: 'Create branch'});
  expect(create.getAttribute('aria-disabled')).toBe('true');
  act(() => {
    fireEvent.click(create);
  });
  expect(sent).toEqual([]);
});

test('the releases page lists a writer\'s drafts (API v1); Publish publishes one', async () => {
  const s = session();
  const draft = {id: 9, tag_name: 'v2.0', target_commitish: 'main', name: 'Second', body: '', draft: true, prerelease: false, created_at: T, assets: []};
  const sent = stubForgejo((method, url) => {
    if (method === 'GET' && url.endsWith('/api/v1/repos/alice/website/releases?draft=true&limit=50')) return {status: 200, json: sent.length ? [] : [draft]};
    if (method === 'PATCH' && url.endsWith('/releases/9')) {
      setTimeout(() => {
        s.data.put('Release', 'repo:20', tag(9, 'v2.0', MAIN, {name: 'Second', is_tag: false}));
      }, 10);
      return {status: 200, json: {...draft, draft: false}};
    }
    return undefined;
  });
  const app = createApp(config, s);
  await open(app, '/alice/website/releases');
  const item = await screen.findByRole('article', {name: 'Draft Second'});
  expect(within(item).getByText('Draft')).toBeTruthy();
  act(() => {
    fireEvent.click(within(item).getByRole('button', {name: 'Publish'}));
  });
  await waitFor(() => {
    expect(screen.queryByRole('article', {name: 'Draft Second'})).toBeNull();
  });
  expect(sent).toEqual([{method: 'PATCH', url: '/api/v1/repos/alice/website/releases/9', body: {draft: false, name: 'Second', prerelease: false}}]);
  expect(screen.getByRole('heading', {name: 'Second'})).toBeTruthy();
});

test('a new release from its canonical address: a new tag from main, published', async () => {
  const s = session();
  const sent = stubForgejo((method, url) => {
    if (method === 'GET' && url.includes('/releases?draft=true')) return {status: 200, json: []};
    if (method === 'POST' && url.endsWith('/api/v1/repos/alice/website/releases')) {
      setTimeout(() => {
        s.data.put('Release', 'repo:20', tag(11, 'v3.0', MAIN, {name: 'v3.0', is_tag: false}));
      }, 10);
      return {status: 201, json: {id: 11, tag_name: 'v3.0'}};
    }
    return undefined;
  });
  const app = createApp(config, s);
  const router = await open(app, '/alice/website/releases/new');
  expect(router.state.location.pathname).toBe('/alice/website/releases/new');
  const tagField = await screen.findByRole('textbox', {name: 'Tag name'});
  fireEvent.change(tagField, {target: {value: 'v1.0'}});
  expect(screen.getByText(/The existing tag/)).toBeTruthy();
  fireEvent.change(tagField, {target: {value: 'v3.0'}});
  expect(screen.getByText(/A new tag, made when the release is published/)).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', {name: /pre-release/}));
  act(() => {
    fireEvent.click(screen.getByRole('button', {name: 'Publish release'}));
  });
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/alice/website/releases');
  });
  expect(sent).toEqual([{method: 'POST', url: '/api/v1/repos/alice/website/releases', body: {
    tag_name: 'v3.0', target_commitish: 'main', name: 'v3.0', body: '', draft: false, prerelease: true,
  }}]);
});

test('the branches page filters by name and shows how far each branch is behind and ahead of the default', async () => {
  const FEATURE = 'c'.repeat(40);
  const s = session();
  s.data.put('Branch', 'repo:20', branch(2, 'feature/map', FEATURE));
  s.data.put('Branch', 'repo:20', branch(3, 'docs', MAIN));
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
  stubForgejo((_method, url) => {
    if (url.endsWith(`/compare/${MAIN}...${FEATURE}`)) return {status: 200, json: {total_commits: 2, commits: []}};
    if (url.endsWith(`/compare/${FEATURE}...${MAIN}`)) return {status: 200, json: {total_commits: 1, commits: []}};
    return undefined;
  });
  await open(createApp(config, s), '/alice/website/branches');
  expect(await screen.findByText('1 commit behind, 2 commits ahead of main')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', {name: 'Search branches'}), {target: {value: 'MAP'}});
  await waitFor(() => { expect(screen.getAllByRole('option')).toHaveLength(1); });
  expect(screen.getByRole('option').textContent).toMatch(/^feature\/map/);
  fireEvent.change(screen.getByRole('textbox', {name: 'Search branches'}), {target: {value: 'nothing'}});
  expect(await screen.findByText('No branch matches')).toBeTruthy();
  vi.restoreAllMocks();
});
