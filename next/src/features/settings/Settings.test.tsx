// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's settings in the app: the general form from the pool (no
// request needed to paint it), a save sending only what changed, the
// features' switches, a list section from API v1, and the refusal for
// someone who does not administer the repository.

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterAll, afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// The shell's idle work (whenIdle: a 200 ms timer in jsdom) runs before the environment goes away.
afterAll(() => new Promise<void>((resolve) => {
  setTimeout(resolve, 300);
}));

/** alice owns alice/notes (id 10: administrator from the pool) and reads acme/website (id 20). */
function session() {
  const me = user(1, 'alice');
  const acme = user(2, 'acme', 'organization');
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:10', units: [], reason: 'owner'}, {group: 'repo:20', units: [], reason: 'member'}]}});
  s.data.put('User', 'profile:1', me);
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:10', repo(10, me, 'notes', {description: 'My notes'}));
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  s.data.put('RepoUnit', 'repo:10', {id: 1, repo_id: 10, type: 'issues', config: {}, default_permissions: '', created_at: T});
  s.data.put('RepoUnit', 'repo:10', {id: 2, repo_id: 10, type: 'pulls', config: {AllowMerge: true, AllowSquash: true, DefaultMergeStyle: 'merge'}, default_permissions: '', created_at: T});
  s.auth.token = () => Promise.resolve('token');
  return s;
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stub(answer: (c: Call) => {status?: number; body?: unknown} | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const c = {method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined};
    calls.push(c);
    const a = answer(c) ?? {status: 404, body: {message: 'not here'}};
    return Promise.resolve(new Response(JSON.stringify(a.body ?? {}), {status: a.status ?? 200, headers: {'Content-Type': 'application/json'}}));
  }));
  return calls;
}

async function open(path: string, s = session()) {
  const app = createApp(config, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return {app, router, s};
}

test('the general settings paint from the pool; a save sends only what changed', async () => {
  const calls = stub((c) => (c.method === 'PATCH' ? {body: {id: 10, name: 'notes', full_name: 'alice/notes'}} : undefined));
  await open('/alice/notes/settings');
  const name = screen.getByRole<HTMLInputElement>('textbox', {name: 'Repository name'});
  expect(name.value).toBe('notes');
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', {name: /Description/}).value).toBe('My notes');
  // The repository's Settings tab is the app's page (administrators only), and the current one.
  const tab = within(screen.getByRole('navigation', {name: 'Repository'})).getByRole('link', {name: 'Settings'});
  expect(tab.getAttribute('href')).toBe('/alice/notes/settings');
  expect(tab.hasAttribute('data-classic')).toBe(false);
  expect(tab.getAttribute('aria-current')).toBe('page');
  // The sections: here, and the rest in the classic UI.
  const nav = screen.getByRole('navigation', {name: 'Settings'});
  expect(within(nav).getByRole('link', {name: /General/}).getAttribute('aria-current')).toBe('page');
  expect(within(nav).getByRole('link', {name: /Units and trackers/}).getAttribute('href')).toBe('/alice/notes/settings/units');
  expect(within(nav).getByRole('link', {name: /More options/}).getAttribute('href')).toBe('/alice/notes/settings?ui=classic');
  // Features from the units: issues and pull requests on, the wiki off.
  expect(screen.getByRole('switch', {name: 'Issues'}).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('switch', {name: 'Wiki'}).getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('switch', {name: 'Squash'}).getAttribute('aria-checked')).toBe('true');

  const save = screen.getByRole('button', {name: 'Save changes'});
  expect(save.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByRole('textbox', {name: /Website/}), {target: {value: 'notes.example'}});
  act(() => {
    fireEvent.click(save);
  });
  // Checked before sending: nothing sent.
  expect(await screen.findByText('An address starting with http:// or https://.')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', {name: /Website/}), {target: {value: 'https://notes.example'}});
  act(() => {
    fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));
  });
  await waitFor(() => {
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([{method: 'PATCH', url: '/api/v1/repos/alice/notes', body: {website: 'https://notes.example'}}]);
  });
  expect(await screen.findByText('Settings saved')).toBeTruthy();
});

test('a switch applies at once, and goes back when Forgejo refuses', async () => {
  const calls = stub((c) => (c.method === 'PATCH' ? {status: 422, body: {message: 'wiki is disabled on this instance'}} : undefined));
  await open('/alice/notes/settings');
  const wiki = screen.getByRole('switch', {name: 'Wiki'});
  act(() => {
    fireEvent.click(wiki);
  });
  expect(wiki.getAttribute('aria-checked')).toBe('true');
  await waitFor(() => {
    expect(wiki.getAttribute('aria-checked')).toBe('false');
  });
  expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({has_wiki: true});
  expect(await screen.findByText('Wiki was not changed')).toBeTruthy();
});

test('webhooks: listed from API v1', async () => {
  stub((c) => (c.url.startsWith('/api/v1/repos/alice/notes/hooks?') ?
    {body: [{id: 4, type: 'forgejo', branch_filter: '*', config: {url: 'https://ci.example/hook', content_type: 'json'}, events: ['push'], active: true, created_at: T, updated_at: T}]} :
    undefined));
  await open('/alice/notes/settings/hooks');
  expect(await screen.findByText('https://ci.example/hook')).toBeTruthy();
  expect(screen.getByText('Push events')).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Send a test delivery'})).toBeTruthy();
});

test('someone who does not administer the repository gets the refusal once Forgejo says so', async () => {
  stub((c) => (c.url === '/api/v1/repos/acme/website' ? {body: {id: 20, permissions: {admin: false, push: true, pull: true}}} : undefined));
  await open('/acme/website/settings');
  expect(await screen.findByText('Only administrators can change settings')).toBeTruthy();
  expect(screen.queryByRole('textbox', {name: 'Repository name'})).toBeNull();
});
