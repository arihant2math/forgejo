// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {runInAction} from 'mobx';
import {connectivity} from '../../app/online.ts';
import {afterAll, afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import type {NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

afterEach(() => {
  vi.unstubAllGlobals();
  runInAction(() => { connectivity.online = true; });
  localStorage.clear();
});

// Let the shell's 200 ms idle timer finish before jsdom teardown.
afterAll(() => new Promise<void>((resolve) => {
  setTimeout(resolve, 300);
}));

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

async function open(path: string, s = session(), cfg = config) {
  const app = createApp(cfg, s);
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
  const tab = within(screen.getByRole('navigation', {name: 'Repository'})).getByRole('link', {name: 'Settings'});
  expect(tab.getAttribute('href')).toBe('/alice/notes/settings');
  expect(tab.hasAttribute('data-classic')).toBe(false);
  expect(tab.getAttribute('aria-current')).toBe('page');
  const nav = screen.getByRole('navigation', {name: 'Settings'});
  expect(within(nav).getByRole('link', {name: /General/}).getAttribute('aria-current')).toBe('page');
  expect(within(nav).getByRole('link', {name: /Units and trackers/}).getAttribute('href')).toBe('/alice/notes/settings/units');
  expect(within(nav).getByRole('link', {name: /More options/}).getAttribute('href')).toBe('/alice/notes/settings?ui=classic');
  expect(screen.getByRole('button', {name: 'Issues'}).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('button', {name: 'Wiki'}).getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByRole('button', {name: 'Squash'}).getAttribute('aria-pressed')).toBe('true');

  const save = screen.getByRole('button', {name: 'Save changes'});
  expect(save.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByRole('textbox', {name: /Website/}), {target: {value: 'notes.example'}});
  act(() => {
    fireEvent.click(save);
  });
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
  const wiki = screen.getByRole('button', {name: 'Wiki'});
  act(() => {
    fireEvent.click(wiki);
  });
  expect(wiki.getAttribute('aria-pressed')).toBe('true');
  await waitFor(() => {
    expect(wiki.getAttribute('aria-pressed')).toBe('false');
  });
  expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({has_wiki: true});
  expect(await screen.findByText('Wiki was not changed')).toBeTruthy();
});

test('the danger zone: GitHub\'s order, every action a danger button, no extra banner', async () => {
  stub(() => undefined);
  await open('/alice/notes/settings');
  const zone = screen.getByRole('region', {name: 'Danger zone'});
  const buttons = within(zone).getAllByRole('button');
  expect(buttons.map((b) => b.textContent)).toEqual(['Change visibility', 'Transfer', 'Archive this repository', 'Delete this repository']);
  expect(buttons.every((b) => b.getAttribute('data-variant') === 'danger')).toBe(true);
  expect(within(zone).getByText('This repository is currently public.')).toBeTruthy();
  expect(screen.queryByText('Repository danger zone')).toBeNull();
});

test('switching the default branch asks first, and only then sends it', async () => {
  const calls = stub((c) => (c.method === 'PATCH' ? {body: {id: 10, name: 'notes', default_branch: 'dev'}} : undefined));
  const s = session();
  for (const [id, name] of [[1, 'main'], [2, 'dev']] as const) {
    s.data.put('Branch', 'repo:10', {id, repo_id: 10, name, commit_id: 'a'.repeat(40), commit_message: '', commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T});
  }
  await open('/alice/notes/settings', s);
  const section = screen.getByRole('region', {name: 'Default branch'});
  expect(within(section).getByText('main')).toBeTruthy();
  fireEvent.click(within(section).getByRole('button', {name: 'Switch to another branch'}));
  fireEvent.click(await screen.findByRole('option', {name: 'dev'}));
  const dialog = await screen.findByRole('alertdialog', {name: 'Switch the default branch to dev?'});
  expect(dialog.textContent).toContain('unintended consequences');
  expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', {name: 'I understand, update the default branch.'}));
  await waitFor(() => {
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{default_branch: 'dev'}]);
  });
});

test('the default branch confirmation says why it cannot switch offline, and sends nothing', async () => {
  const calls = stub(() => undefined);
  const s = session();
  for (const [id, name] of [[1, 'main'], [2, 'dev']] as const) {
    s.data.put('Branch', 'repo:10', {id, repo_id: 10, name, commit_id: 'a'.repeat(40), commit_message: '', commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T});
  }
  await open('/alice/notes/settings', s);
  const section = screen.getByRole('region', {name: 'Default branch'});
  fireEvent.click(within(section).getByRole('button', {name: 'Switch to another branch'}));
  fireEvent.click(await screen.findByRole('option', {name: 'dev'}));
  await screen.findByRole('alertdialog', {name: 'Switch the default branch to dev?'});
  act(() => { runInAction(() => { connectivity.online = false; }); });
  const dialog = screen.getByRole('dialog', {name: 'Switch the default branch to dev?'});
  expect(within(dialog).getByText(/Changing the default branch needs a connection/)).toBeTruthy();
  const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {name: 'I understand, update the default branch.'});
  expect(confirm.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
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

test('the side nav: GitHub\'s groups, classic-only pages inside them, only the open page current', async () => {
  stub(() => undefined);
  await open('/alice/notes/settings/hooks', session(), {...config, git_hooks_enabled: true, lfs_enabled: true});
  const nav = screen.getByRole('navigation', {name: 'Settings'});
  const names = (el: HTMLElement) => within(el).getAllByRole('link').map((a) => a.textContent);
  expect(names(nav)).toEqual(['General', 'Units and trackers', 'More options', 'Collaborators', 'Branches', 'Tags', 'Actions', 'Webhooks', 'Git hooks', 'LFS', 'Deploy keys', 'Secrets and variables']);
  for (const [group, items] of [['Access', ['Collaborators']], ['Code and automation', ['Branches', 'Tags', 'Actions', 'Webhooks', 'Git hooks', 'LFS']], ['Security', ['Deploy keys', 'Secrets and variables']]] as const) {
    const heading = within(nav).getByText(group, {selector: 'h3, [id]'});
    const list = heading.closest('li')?.querySelector('ul');
    if (!list) throw new Error(`no ${group} list`);
    expect(names(list)).toEqual(items);
  }
  expect(within(nav).getAllByRole('link', {current: 'page'}).map((a) => a.textContent)).toEqual(['Webhooks']);
  const secrets = within(nav).getByRole('link', {name: /Secrets and variables/});
  expect(secrets.getAttribute('href')).toBe('/alice/notes/settings/actions/secrets');
  expect(secrets.hasAttribute('data-classic')).toBe(true);
  expect(within(nav).getByRole('link', {name: /^Webhooks/}).hasAttribute('data-classic')).toBe(false);
});

test('deleting a deploy key confirms first; a refusal stays in the dialog, a success drops the row', async () => {
  let refuse = true;
  const calls = stub((c) => {
    if (c.method === 'DELETE') return refuse ? {status: 500, body: {message: 'storage is down'}} : {status: 200};
    return c.url.startsWith('/api/v1/repos/alice/notes/keys') ? {body: [{id: 7, key_id: 7, title: 'CI runner', key: 'ssh-ed25519 AAAA', fingerprint: 'SHA256:x', read_only: true, created_at: T}]} : undefined;
  });
  await open('/alice/notes/settings/keys');
  fireEvent.click(await screen.findByRole('button', {name: 'Delete the key “CI runner”'}));
  const dialog = screen.getByRole('alertdialog', {name: 'Delete the key “CI runner”?'});
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  fireEvent.click(within(dialog).getByRole('button', {name: 'Delete key'}));
  expect(await within(dialog).findByText('storage is down')).toBeTruthy();
  expect(screen.getByText('CI runner')).toBeTruthy();
  refuse = false;
  fireEvent.click(within(dialog).getByRole('button', {name: 'Delete key'}));
  await waitFor(() => { expect(screen.queryByRole('alertdialog')).toBeNull(); });
  expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/v1/repos/alice/notes/keys/7', '/api/v1/repos/alice/notes/keys/7']);
  expect(await screen.findByText('Deleted the key “CI runner”')).toBeTruthy();
  expect(screen.queryByRole('button', {name: 'Delete the key “CI runner”'})).toBeNull();
});

test('webhook events are a radio group with GitHub\'s choices', async () => {
  stub((c) => (c.url.startsWith('/api/v1/repos/alice/notes/') ? {body: []} : undefined));
  await open('/alice/notes/settings/hooks');
  fireEvent.click(await screen.findByRole('button', {name: 'Add webhook'}));
  const events = within(screen.getByRole('dialog', {name: 'Add a webhook'})).getByRole('group', {name: 'Which events would you like to trigger this webhook?'});
  expect(within(events).getAllByRole('radio').map((r) => [r.parentElement?.parentElement?.textContent, (r as HTMLInputElement).checked])).toEqual([
    ['Just the push event.', true], ['Send me everything.', false], ['Let me select individual events.', false],
  ]);
  expect(screen.queryByRole('group', {name: 'Issues'})).toBeNull();
  fireEvent.click(within(events).getByRole('radio', {name: 'Let me select individual events.'}));
  expect(screen.getByRole('group', {name: 'Issues'})).toBeTruthy();
});

test('who may push to a protected branch is a radio group with captions', async () => {
  stub((c) => (c.url.startsWith('/api/v1/repos/alice/notes/') ? {body: []} : undefined));
  await open('/alice/notes/settings/branches');
  const add = await screen.findByRole('button', {name: 'Add rule'});
  await waitFor(() => { expect((add as HTMLButtonElement).disabled).toBe(false); });
  fireEvent.click(add);
  const push = within(screen.getByRole('dialog', {name: 'Protect a branch'})).getByRole('group', {name: 'Who may push'});
  const radios = within(push).getAllByRole<HTMLInputElement>('radio');
  expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
  expect(within(push).getByText(/only by merging pull requests/)).toBeTruthy();
  expect(screen.queryByRole('textbox', {name: 'People who may push'})).toBeNull();
  fireEvent.click(within(push).getByRole('radio', {name: 'Only some people'}));
  expect(screen.getByRole('textbox', {name: 'People who may push'})).toBeTruthy();
});

test('someone who does not administer the repository gets the refusal once Forgejo says so', async () => {
  stub((c) => (c.url === '/api/v1/repos/acme/website' ? {body: {id: 20, permissions: {admin: false, push: true, pull: true}}} : undefined));
  await open('/acme/website/settings');
  expect(await screen.findByText('Only administrators can change settings')).toBeTruthy();
  expect(screen.queryByRole('textbox', {name: 'Repository name'})).toBeNull();
  // The way back to the repository is not the current page (TanStack's prefix match would say so).
  expect(screen.getByRole('link', {name: 'Go to the repository'}).getAttribute('aria-current')).toBeNull();
});

test('going offline keeps drafts and disables online-only repository controls immediately', async () => {
  const calls = stub(() => undefined);
  await open('/alice/notes/settings');
  fireEvent.change(screen.getByRole('textbox', {name: 'Repository name'}), {target: {value: 'draft-name'}});
  const save = screen.getByRole<HTMLButtonElement>('button', {name: 'Save changes'});
  expect(save.disabled).toBe(false);
  act(() => { runInAction(() => { connectivity.online = false; }); });
  expect(screen.getByText('You are offline')).toBeTruthy();
  expect(save.disabled).toBe(true);
  expect(screen.getByRole('button', {name: 'Wiki'}).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole<HTMLInputElement>('textbox', {name: 'Repository name'}).value).toBe('draft-name');
  expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  act(() => { runInAction(() => { connectivity.online = true; }); });
  expect(save.disabled).toBe(false);
});

test('the side nav leaves out Git hooks and LFS when the instance has them off', async () => {
  stub(() => undefined);
  await open('/alice/notes/settings/hooks');
  const nav = screen.getByRole('navigation', {name: 'Settings'});
  const links = within(nav).getAllByRole('link').map((a) => a.textContent);
  expect(links).toContain('Webhooks');
  expect(links).not.toContain('Git hooks');
  expect(links).not.toContain('LFS');
});
