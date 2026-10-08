// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {runInAction} from 'mobx';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, describe, expect, test} from 'vitest';
import type {NextConfig} from '../protocol/types.gen.ts';
import {classConflicts} from '../test/conflicts.ts';
import {fakeSession, issue, repo, user} from '../test/fakeSession.ts';
import {App} from './App.tsx';
import {BootShell} from './BootShell.tsx';
import {createAppRouter} from './router.tsx';
import {SKELETON_MAX_ROWS} from './splash.ts';
import {createApp, type Session} from './store.ts';

afterEach(() => {
  localStorage.clear();
});

function config(oauth = false): NextConfig {
  return {
    app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1,
    oauth: oauth ?
      {client_id: 'cid', redirect_uri: 'http://localhost/-/next/callback', scope: 'write:issue', authorize_url: '/login/oauth/authorize', token_url: '/login/oauth/access_token'} :
      null,
  };
}

async function renderApp(path: string, session?: Session, cfg = config()) {
  const app = createApp(cfg, session);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  const r = render(<App app={app} router={router}/>);
  return {app, router, ...r};
}

function signedIn() {
  const me = user(1, 'alice');
  const acme = user(2, 'acme', 'organization');
  const s = fakeSession({
    workspace: {
      viewer_id: 1, truncated: false, max_repos: 200,
      groups: [
        {group: 'user:1', units: [], reason: 'self'},
        {group: 'org:2', units: [], reason: 'member'},
        {group: 'repo:10', units: [], reason: 'owner'},
        {group: 'repo:20', units: [], reason: 'member'},
        {group: 'repo:21', units: [], reason: 'member'},
      ],
    },
  });
  s.data.put('User', 'profile:1', me);
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:10', repo(10, me, 'notes'));
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  s.data.put('Repository', 'repo:21', repo(21, acme, 'api'));
  s.data.put('Issue', 'repo:20', issue(100, 20, 7, 'Footer links are broken'));
  s.data.put('Issue', 'repo:10', issue(101, 10, 1, 'Crash when saving settings'));
  s.data.put('Notification', 'user:1', {id: 1, user_id: 1, repo_id: 20, status: 'unread', subject: 'issue', issue_id: 100, comment_id: 0, created_at: '', updated_at: ''});
  return s;
}

function key(k: string, init: KeyboardEventInit = {}) {
  act(() => {
    fireEvent.keyDown(document.body, {key: k, ...init});
  });
}

describe('boot', () => {
  test('the static boot shell has the full set of skeleton rows (the splash script hides extras)', () => {
    const html = renderToStaticMarkup(<BootShell/>);
    expect(html.match(/data-sk-row=""/g)).toHaveLength(SKELETON_MAX_ROWS);
    expect(html).toContain('logged-out:flex');
    const div = document.createElement('div');
    div.innerHTML = html;
    expect(classConflicts(div)).toEqual([]);
  });

  test.each(['/-/next/', '/', '/issues', '/user2/repo1/issues/3'])('the logged-out boot shell is exactly what %s renders (wrapper included)', async (path) => {
    const shell = document.createElement('div');
    shell.innerHTML = renderToStaticMarkup(<BootShell/>);
    const {container} = await renderApp(path, undefined, config(true));
    const panel = shell.querySelector('.logged-out\\:flex');
    // The boot copy is hidden unless the splash says logged-out; otherwise identical.
    expect(panel?.outerHTML.replace('hidden logged-out:flex', 'flex')).toBe(container.firstElementChild?.outerHTML);
  });

  test('without OAuth2 on the server, signing in is unavailable (and says so)', async () => {
    await renderApp('/');
    expect(screen.getByRole('button', {name: 'Sign in'}).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Signing in is not available on this server.')).toBeTruthy();
  });

  test('unknown paths below the base: not found', async () => {
    await renderApp('/-/next/no/such/page');
    expect(screen.getByText('Not available here')).toBeTruthy();
  });

  test('the gallery route is available in dev', async () => {
    await renderApp('/-/next/gallery');
    expect(screen.getByRole('heading', {name: 'Primitives'})).toBeTruthy();
    // The gallery renders every primitive and variant: none may set a property twice.
    expect(classConflicts(document.body)).toEqual([]);
  });
});

describe('signed in', () => {
  test('the shell: account, views, the workspace by owner, and the page', async () => {
    const s = signedIn();
    await renderApp('/', s);
    const sidebar = screen.getByRole('complementary', {name: 'Sidebar'});
    expect(within(sidebar).getAllByRole('button', {name: 'alice'}).filter((b) => b.getAttribute('aria-haspopup') === 'menu')).toHaveLength(1);
    expect(within(sidebar).getByRole('link', {name: /Inbox/}).textContent).toBe('Inbox1');
    const groups = within(sidebar).getAllByRole('group');
    // The viewer first, then the organizations; repositories by name.
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['alice', 'acme']);
    const acme = within(sidebar).getByRole('group', {name: 'acme'});
    expect(within(acme).getAllByRole('link').map((a) => a.textContent)).toEqual(['api', 'website']);
    expect(within(acme).getByRole('link', {name: 'website'}).getAttribute('href')).toBe('/acme/website/issues');
    expect(screen.getByRole('heading', {name: 'Home'})).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Live');
    expect(classConflicts(document.body)).toEqual([]);
  });

  test('a collapsed owner stays collapsed (persisted)', async () => {
    const s = signedIn();
    const first = await renderApp('/', s);
    fireEvent.click(screen.getByRole('button', {name: 'acme'}));
    expect(screen.queryByRole('link', {name: 'website'})).toBeNull();
    first.unmount();
    await renderApp('/', s);
    expect(screen.getByRole('button', {name: 'acme'}).getAttribute('aria-expanded')).toBe('false');
  });

  test('G then I/P/N navigate; typing in a field does not', async () => {
    const {router} = await renderApp('/', signedIn());
    key('g');
    key('i');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/issues');
    });
    expect(screen.getByRole('heading', {name: 'My issues'})).toBeTruthy();
    key('g');
    key('n');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/notifications');
    });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    act(() => {
      fireEvent.keyDown(input, {key: 'g'});
      fireEvent.keyDown(input, {key: 'p'});
    });
    expect(router.state.location.pathname).toBe('/notifications');
    input.remove();
  });

  test('⌘K / Ctrl K: the palette searches the pool and opens the result', async () => {
    const {router, app} = await renderApp('/', signedIn());
    key('k', {ctrlKey: true});
    expect(app.ui.paletteOpen).toBe(true);
    const input = await screen.findByPlaceholderText('Search repositories, issues and commands…');
    fireEvent.change(input, {target: {value: 'footer'}});
    const option = await screen.findByRole('option', {name: /Footer links are broken/});
    expect(option.textContent).toContain('acme/website#7');
    expect(classConflicts(document.body)).toEqual([]);
    fireEvent.click(option);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/acme/website/issues/7');
    });
    expect(app.ui.paletteOpen).toBe(false);
    expect(await screen.findByRole('heading', {level: 1, name: /Footer links are broken/})).toBeTruthy();
    expect(performance.getEntriesByName('palette:search').length).toBeGreaterThan(0);
  });

  test('closing the palette gives focus back to where it was', async () => {
    await renderApp('/', signedIn());
    const issues = screen.getByRole('link', {name: /My issues/});
    issues.focus();
    key('k', {ctrlKey: true});
    const input = await screen.findByPlaceholderText('Search repositories, issues and commands…');
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    fireEvent.keyDown(input, {key: 'Escape'});
    await waitFor(() => {
      expect(document.activeElement).toBe(issues);
    });
  });

  test('a repository page holds its group while open', async () => {
    const s = signedIn();
    const {router} = await renderApp('/acme/website/issues', s);
    expect(screen.getByRole('heading', {name: 'Issues'})).toBeTruthy();
    expect(s.data.held.get('repo:20')).toBe(1);
    await act(() => router.navigate({to: '/'}));
    expect(s.data.held.has('repo:20')).toBe(false);
  });

  test('an unknown repository offline: not available offline, with what is', async () => {
    const s = signedIn();
    const {connectivity} = await import('./online.ts');
    runInAction(() => {
      connectivity.online = false;
    });
    try {
      await renderApp('/nobody/nothing/issues', s);
      expect(screen.getByText('Not available offline')).toBeTruthy();
      expect(screen.getByRole('navigation', {name: 'Available on this device'}).textContent).toContain('My issues');
    } finally {
      runInAction(() => {
        connectivity.online = true;
      });
    }
  });

  test('an issue created offline: its page shows it at once, and the URL becomes its number once Forgejo created it', async () => {
    const s = signedIn();
    const app0 = createApp(config(), s);
    const {editing} = await import('../intents/session.ts');
    const {tempNum} = await import('../intents/intents.ts');
    const t = crypto.randomUUID();
    const temp = tempNum(t);
    editing(app0).intents.submit({kind: 'issue.create', issueId: temp, repoId: 20, tempId: t, title: 'Made offline', body: 'Body typed offline', labelIds: [], assigneeIds: [], milestoneId: 0});
    const router = createAppRouter(app0, createMemoryHistory({initialEntries: [`/acme/website/issues/new-${t}`]}));
    await router.load();
    render(<App app={app0} router={router}/>);
    await waitFor(() => {
      expect(screen.getByRole('main').querySelector('article h2')?.textContent).toContain('Made offline');
    });
    expect(screen.getByText('Body typed offline')).toBeTruthy();
    expect(screen.getByText('New')).toBeTruthy();
    // Created: the server's issue arrives and the temporary id is remapped; the URL follows (replace).
    act(() => {
      s.data.put('Issue', 'repo:20', issue(555, 20, 42, 'Made offline'));
      runInAction(() => editing(app0).intents.remapped.set(temp, 555));
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/acme/website/issues/42');
    });
    expect(router.history.length).toBe(1);
  });

  test('the sync indicator: offline with pending intents, signed out with a sign-in button', async () => {
    const s = signedIn();
    const {app} = await renderApp('/', s, config(true));
    act(() => {
      runInAction(() => {
        s.data.status.connection = 'offline';
        app.ui.pendingIntents = 3;
      });
    });
    expect(screen.getByRole('status').textContent).toBe('Offline · 3 pending');
    act(() => {
      runInAction(() => {
        s.auth.status.state = 'expired';
      });
    });
    expect(screen.getByRole('status').textContent).toContain('Signed out');
    expect(screen.getByRole('button', {name: 'Sign in'})).toBeTruthy();
  });

  test('signing out with unsynced intents asks first', async () => {
    const s = signedIn();
    s.data.intents = 2;
    const {app} = await renderApp('/', s);
    const {requestSignOut} = await import('./session.ts');
    await act(() => requestSignOut(app));
    expect(await screen.findByText('2 changes have not reached Forgejo yet. Signing out deletes them from this device.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Cancel'}));
    expect(app.ui.signOut).toBeUndefined();
  });

  test('? lists the shortcuts that work here', async () => {
    await renderApp('/', signedIn());
    key('?', {shiftKey: true});
    const dialog = await screen.findByRole('dialog', {name: 'Keyboard shortcuts'});
    expect(within(dialog).getByText('Go to my issues')).toBeTruthy();
    expect(within(dialog).queryByText('Next item')).toBeNull(); // no list on this page
  });
});
