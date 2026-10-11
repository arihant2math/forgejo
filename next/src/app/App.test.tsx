// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {runInAction} from 'mobx';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, describe, expect, test, vi} from 'vitest';
import type {NextConfig} from '../protocol/types.gen.ts';
import {classConflicts} from '../test/conflicts.ts';
import {fakeSession, issue, repo, user} from '../test/fakeSession.ts';
import {App} from './App.tsx';
import {BootShell} from './BootShell.tsx';
import {createAppRouter} from './router.tsx';
import {notify, removeNotice, undoLatest} from './notices.ts';
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

test('global undo identifies a change even after its notice is gone', () => {
  const app = createApp(config(), undefined);
  const undo = vi.fn();
  const id = notify(app, {tone: 'neutral', title: '#8 moved to To do', action: {label: 'Undo', run: undo}});
  removeNotice(app, id);
  undoLatest(app);
  expect(undo).toHaveBeenCalledOnce();
  expect(app.ui.notices.at(-1)?.title).toBe('Undid: #8 moved to To do');
  undoLatest(app);
  expect(undo).toHaveBeenCalledOnce();
  for (const notice of [...app.ui.notices]) removeNotice(app, notice.id);
});

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
  s.data.put('Notification', 'user:1', {id: 1, user_id: 1, repo_id: 20, status: 'unread', subject: 'issue', issue_id: 100, comment_id: 0, actor_id: 0, created_at: '', updated_at: ''});
  return s;
}

function key(k: string, init: KeyboardEventInit = {}) {
  act(() => {
    fireEvent.keyDown(document.body, {key: k, ...init});
  });
}

test('owner addresses use the known login spelling', async () => {
  const {router} = await renderApp('/ALICE', signedIn());
  await waitFor(() => { expect(router.state.location.pathname).toBe('/alice'); });
});

test('Escape closes the phone drawer and returns focus to its opener', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()})));
  try {
    await renderApp('/', signedIn());
    const opener = await screen.findByRole('button', {name: 'Show the sidebar'});
    opener.focus();
    fireEvent.click(opener);
    expect(document.documentElement.dataset.drawer).toBe('open');
    key('Escape');
    expect(document.documentElement.dataset.drawer).toBeUndefined();
    expect(document.activeElement).toBe(opener);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('boot', () => {
  test('the static boot shell has the full set of skeleton rows (the splash script hides extras)', () => {
    const html = renderToStaticMarkup(<BootShell/>);
    expect(html.match(/data-sk-row=""/g)).toHaveLength(SKELETON_MAX_ROWS);
    expect(html).toContain('logged-out:flex');
    // A repository page's header rows under the first (the splash's data-header shows them).
    expect(html).toContain('header-tabs:contents');
    expect(html).toContain('header-toolbar:contents');
    const div = document.createElement('div');
    div.innerHTML = html;
    expect(classConflicts(div)).toEqual([]);
  });

  // The app's first element inside Primer's BaseStyles wrapper (app/App.tsx PrimerTheme).
  const appRoot = (container: HTMLElement) => container.querySelector('[data-component="BaseStyles"]')?.firstElementChild;

  test.each(['/-/next/', '/', '/issues', '/user2/repo1/issues/3'])('the logged-out boot shell is exactly what %s renders (wrapper included)', async (path) => {
    const shell = document.createElement('div');
    shell.innerHTML = renderToStaticMarkup(<BootShell/>);
    const {container} = await renderApp(path, undefined, config(true));
    const panel = shell.querySelector('.logged-out\\:flex');
    // The boot copy is hidden unless the splash says logged-out; otherwise identical, but for the classic links'
    // addresses (the app knows them): the first frame keeps their place, invisible.
    const links = / invisible" aria-hidden="true"/;
    expect(panel?.outerHTML).toMatch(links);
    // Inline styles (an octicon's vertical-align) serialize with spaces from the DOM, without from React's markup.
    const styles = (html = '') => html.replace(/ href="[^"]*"/g, '').replace(/style="([^"]*)"/g, (_, css: string) => `style="${css.replace(/\s+|;$/g, '')}"`);
    expect(styles(panel?.outerHTML.replace('hidden logged-out:flex', 'flex').replace(links, '"')))
      .toBe(styles(appRoot(container)?.outerHTML));
  });

  test('without OAuth2 on the server, signing in is unavailable (and says so)', async () => {
    await renderApp('/');
    expect(screen.getByRole('button', {name: 'Sign in'}).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Signing in is not available on this server.')).toBeTruthy();
  });

  test('unknown paths below the base: the shell (signed out: sign in)', async () => {
    await renderApp('/-/next/no/such/page');
    expect(screen.getByRole('button', {name: 'Sign in'})).toBeTruthy();
  });

});

describe('signed in', () => {
  test('the shell: account, views, the workspace by owner, and the page', async () => {
    const s = signedIn();
    await renderApp('/', s);
    const sidebar = screen.getByRole('complementary', {name: 'Sidebar'});
    expect(within(sidebar).getAllByRole('button', {name: 'alice'}).filter((b) => b.getAttribute('aria-haspopup') === 'menu')).toHaveLength(1);
    expect(within(within(sidebar).getByRole('link', {name: /Inbox/})).getByText('1')).toBeTruthy();
    const groups = within(sidebar).getAllByRole('group');
    // The viewer first, then the organizations; repositories by name.
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['alice', 'acme']);
    const acme = within(sidebar).getByRole('group', {name: 'acme'});
    // The owner's name opens its page; its repositories follow.
    expect(within(acme).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/acme', '/acme/api', '/acme/website']);
    expect(within(sidebar).getByRole('link', {name: 'Home'}).getAttribute('aria-current')).toBe('page');
    expect(within(acme).getByRole('link', {name: 'website'}).getAttribute('href')).toBe('/acme/website');
    expect(screen.getByRole('heading', {name: 'Home'})).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Live');
    expect(classConflicts(document.body)).toEqual([]);
  });

  test('home lists what is waiting: unread notifications, as links, with the full list a click away', async () => {
    const s = signedIn();
    await renderApp('/', s);
    const unread = await screen.findByRole('region', {name: 'Unread'});
    const row = within(unread).getByRole('link', {name: /Footer links are broken/});
    expect(row.getAttribute('href')).toBe('/acme/website/issues/7');
    expect(row.textContent).toContain('acme/website#7');
    expect(within(unread).getByRole('link', {name: 'View all'}).getAttribute('href')).toBe('/notifications?filter=unread');
    expect(classConflicts(document.body)).toEqual([]);
  });

  test('an unknown address keeps the shell and offers the classic page', async () => {
    const s = signedIn();
    await renderApp('/-/next/acme/website/settings/units', s);
    expect(screen.getByRole('complementary', {name: 'Sidebar'})).toBeTruthy();
    // The classic UI has the page: "Not available here" (a page nobody has is "Not found").
    expect(screen.getByRole('heading', {name: 'Not available here'})).toBeTruthy();
    expect((await screen.findByRole('link', {name: /Open this page/})).getAttribute('href')).toBe('/acme/website/settings/units');
    expect(screen.getByRole('link', {name: /Go to Home/})).toBeTruthy();
  });

  test('a repository\'s address below the base is its home; the sidebar marks it on all its pages', async () => {
    const s = signedIn();
    const {router} = await renderApp('/-/next/acme/website/', s);
    expect(router.state.location.pathname).toBe('/acme/website');
    const sidebar = screen.getByRole('complementary', {name: 'Sidebar'});
    expect(within(sidebar).getByRole('link', {name: 'website'}).getAttribute('aria-current')).toBe('page');
    // The repository header: the owner and the repository are links, the tabs lead everywhere.
    const crumbs = screen.getByRole('navigation', {name: 'Breadcrumb'});
    expect(within(crumbs).getByRole('link', {name: 'acme'}).getAttribute('href')).toBe('/acme');
    const tabs = screen.getByRole('navigation', {name: 'Repository'});
    // GitHub's order; the home is the Code tab. Pages only the classic UI has are marked (data-classic).
    expect(within(tabs).getAllByRole('link').map((a) => a.textContent)).toEqual(['Code', 'Issues1', 'Pull requests', 'Actions', 'Projects', 'Wiki', 'Activity']);
    expect(within(tabs).getByRole('link', {name: 'Code'}).getAttribute('aria-current')).toBe('page');
    // The home has no title row (GitHub's): its heading is the repository's crumb; the browser tab names the
    // repository alone. The header's rows are breadcrumb, then tabs; the repository's actions (New issue, Star, …)
    // are in the home's own title row, not the header (#252).
    expect(screen.getByRole('heading', {level: 1}).textContent).toBe('website');
    expect(within(crumbs).getByRole('heading', {level: 1})).toBeTruthy();
    const header = crumbs.closest('header');
    expect(header?.contains(tabs)).toBe(true);
    expect(crumbs.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(header ?? document.body).queryByRole('button', {name: /New issue/})).toBeNull();
    expect(screen.getByRole('main').querySelector('h2')?.parentElement?.textContent).toContain('New issue');
    await waitFor(() => {
      expect(document.title).toBe('acme/website · Forgejo');
    });
    expect(within(tabs).getByRole('link', {name: 'Wiki'}).getAttribute('href')).toBe('/acme/website/wiki');
    // Projects stays in the app even before the repository has a board.
    expect(within(tabs).getByRole('link', {name: 'Wiki'}).hasAttribute('data-classic')).toBe(false);
    expect(within(tabs).getByRole('link', {name: 'Activity'}).hasAttribute('data-classic')).toBe(false);
    expect(within(tabs).getByRole('link', {name: 'Projects'}).hasAttribute('data-classic')).toBe(false);
    expect(within(tabs).getByRole('link', {name: 'Projects'}).getAttribute('href')).toContain('/-/next/boards?repoId=');
    expect(within(tabs).getByRole('button', {name: 'More of this repository'})).toBeTruthy();
    await router.navigate({to: '/$owner/$repo/issues', params: {owner: 'acme', repo: 'website'}});
    await waitFor(() => {
      expect(within(screen.getByRole('navigation', {name: 'Repository'})).getByRole('link', {name: /^Issues/}).getAttribute('aria-current')).toBe('page');
    });
    expect(within(sidebar).getByRole('link', {name: 'website'}).getAttribute('aria-current')).toBe('page');
  });

  test('the overview\'s files are headed like GitHub\'s: the branch picker, the branches and tags, Go to file, Code, the history', async () => {
    const s = signedIn();
    const branch = (id: number, name: string, sha: string) => ({
      id, repo_id: 20, name, commit_id: sha, commit_message: `Tip of ${name}`, commit_time: '2026-10-01T00:00:00Z', pusher_id: 1,
      is_deleted: false, deleted_by_id: 0, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
    });
    s.data.put('Branch', 'repo:20', branch(1, 'main', 'a'.repeat(40)));
    s.data.put('Branch', 'repo:20', branch(2, 'small', 'b'.repeat(40)));
    // The page starts the highlighter when idle (for the README's code blocks): no workers here.
    vi.stubGlobal('Worker', class {
      addEventListener = () => undefined;
      removeEventListener = () => undefined;
      postMessage = () => undefined;
      terminate = () => undefined;
    });
    await renderApp('/acme/website', s);
    // At once, above the files panel, while its tree is still loading (no layout shift when it arrives).
    const picker = screen.getByRole('button', {name: 'Ref: main'});
    const files = screen.getByRole('region', {name: 'Files'});
    expect(picker.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(files.contains(picker)).toBe(false);
    expect(screen.getByRole('link', {name: '2 branches'}).getAttribute('href')).toBe('/acme/website/branches');
    expect(screen.getByRole('link', {name: '0 tags'}).getAttribute('href')).toBe('/acme/website/tags');
    expect(files.contains(screen.getByRole('button', {name: 'Go to file'}))).toBe(false);
    expect(files.contains(screen.getByRole('button', {name: 'Code'}))).toBe(false);
    expect(screen.getByRole('link', {name: 'History'}).getAttribute('href')).toBe('/acme/website/commits/branch/main');
    expect(screen.getByRole('link', {name: 'Tip of main'})).toBeTruthy();
    expect(screen.queryByRole('link', {name: 'Browse code'})).toBeNull();
  });

  test('a repository\'s code address (spaRoutes {code}) opens the app\'s code view; a pull request\'s Files its tab', async () => {
    const s = signedIn();
    const code = await renderApp('/acme/website/src/branch/main/README.md', s);
    expect(code.router.state.location.pathname).toBe('/acme/website/src/branch/main/README.md');
    code.unmount();
    const files = await renderApp('/acme/website/pulls/3/files', s);
    expect(files.router.state.location.pathname).toBe('/acme/website/pulls/3');
    expect(files.router.state.location.search).toEqual({tab: 'files'});
  });

  test('a collapsed owner stays collapsed (persisted)', async () => {
    const s = signedIn();
    const first = await renderApp('/', s);
    fireEvent.click(screen.getByRole('button', {name: 'Collapse acme'}));
    expect(screen.queryByRole('link', {name: 'website'})).toBeNull();
    first.unmount();
    await renderApp('/', s);
    expect(screen.getByRole('button', {name: 'Expand acme'}).getAttribute('aria-expanded')).toBe('false');
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
    const input = await screen.findByPlaceholderText(/^Search repositories, issues/);
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

  test('the palette selects its first row (never Sign out), and an exact reference first', async () => {
    const {app} = await renderApp('/', signedIn());
    key('k', {ctrlKey: true});
    const input = await screen.findByPlaceholderText(/^Search repositories, issues/);
    const selected = () => document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? '';
    // Never by default; typed out by name, Enter runs it (signing out still asks when changes are unsynced).
    fireEvent.change(input, {target: {value: 'sign'}});
    await waitFor(() => {
      expect(screen.getByRole('option', {name: /Sign out/})).toBeTruthy();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(selected()).toBe('');
    fireEvent.keyDown(input, {key: 'Enter'});
    expect(app.ui.paletteOpen).toBe(true);
    fireEvent.keyDown(input, {key: 'ArrowDown'});
    await waitFor(() => { expect(selected()).toContain('Sign out'); });
    for (const [query, label] of [['?', 'Keyboard shortcuts'], ['undo', 'Undo the last change'], ['g i', 'Go to my issues']]) {
      fireEvent.change(input, {target: {value: query}});
      await waitFor(() => { expect(selected()).toContain(label); });
    }
    fireEvent.change(input, {target: {value: 'sign out'}});
    await waitFor(() => {
      expect(selected()).toContain('Sign out');
    });
    fireEvent.change(input, {target: {value: 'dark theme'}});
    await waitFor(() => {
      expect(selected()).toContain('Switch to the dark theme');
    });
    fireEvent.change(input, {target: {value: 'website#7'}});
    await waitFor(() => {
      expect(selected()).toContain('Footer links are broken');
    });
    // A command that cannot run here is listed with the reason (Enter says it, and never opens something else).
    fireEvent.change(input, {target: {value: 'go to the code'}});
    await waitFor(() => {
      expect(selected()).toContain('Go to the code');
    });
    expect(selected()).toContain('Open a repository first');
    // A command named by an alias comes before titles that merely contain its words.
    fireEvent.change(input, {target: {value: 'new issue'}});
    await waitFor(() => {
      expect(selected()).toContain('Create an issue');
    });
  });

  test('the palette Undo runs the same pending change as Ctrl Z', async () => {
    const {app} = await renderApp('/', signedIn());
    const undo = vi.fn();
    notify(app, {tone: 'success', title: 'Card moved', action: {label: 'Undo', run: undo}});
    key('k', {ctrlKey: true});
    const input = await screen.findByPlaceholderText(/^Search repositories, issues/);
    fireEvent.change(input, {target: {value: 'undo'}});
    await waitFor(() => { expect(screen.getByRole('option', {name: /Undo the last change/}).getAttribute('aria-selected')).toBe('true'); });
    fireEvent.keyDown(input, {key: 'Enter'});
    expect(undo).toHaveBeenCalledOnce();
  });

  test('the palette has one unavailable Up command at the code root, including slash-named refs', async () => {
    const session = signedIn();
    session.data.put('Branch', 'repo:20', {
      id: 1, repo_id: 20, name: 'feature/x', commit_id: 'a'.repeat(40), commit_message: '', commit_time: '', pusher_id: 1,
      is_deleted: false, deleted_by_id: 0, created_at: '', updated_at: '',
    });
    const {app} = await renderApp('/acme/website/src/branch/feature/x', session);
    await screen.findByRole('navigation', {name: 'Repository'});
    key('k', {ctrlKey: true});
    const input = await screen.findByPlaceholderText(/^Search repositories, issues/);
    const up = screen.getAllByRole('option', {name: /Up a directory/});
    expect(up).toHaveLength(1);
    expect(up[0]?.textContent).toContain('Already at the repository root');
    expect(up[0]?.textContent).toContain('or');
    expect(up[0]?.getAttribute('aria-selected')).toBe('false');
    fireEvent.change(input, {target: {value: 'up a directory'}});
    fireEvent.click(screen.getByRole('option', {name: /Up a directory/}));
    await waitFor(() => { expect(app.ui.notices.some((n) => n.title === 'Already at the repository root')).toBe(true); });
  });

  test('the palette ranks repository sections above global commands and can copy its clone URL', async () => {
    const {app, router} = await renderApp('/', signedIn());
    runInAction(() => { app.ui.repoOpen = 20; });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true});
    try {
      key('k', {ctrlKey: true});
      const input = await screen.findByPlaceholderText(/^Search repositories, issues/);
      const selected = () => document.querySelector('[role="option"][aria-selected="true"]')?.textContent ?? '';
      for (const query of ['issues', 'pull requests', 'commits', 'branches', 'releases', 'actions', 'wiki']) {
        fireEvent.change(input, {target: {value: query}});
        await waitFor(() => { expect(selected().toLowerCase()).toContain(`go to ${query} of acme/website`); });
      }
      fireEvent.change(input, {target: {value: 'go to commits'}});
      await waitFor(() => { expect(selected()).toContain('Go to Commits of acme/website'); });
      fireEvent.change(input, {target: {value: 'g i'}});
      await waitFor(() => { expect(selected()).toContain('Go to my issues'); });
      fireEvent.change(input, {target: {value: 'clone'}});
      await waitFor(() => { expect(selected()).toContain('Copy the clone URL'); });
      fireEvent.keyDown(input, {key: 'Enter'});
      await waitFor(() => { expect(writeText).toHaveBeenCalledWith('http://localhost/acme/website.git'); });
      key('k', {ctrlKey: true});
      const reopened = await screen.findByPlaceholderText(/^Search repositories, issues/);
      fireEvent.change(reopened, {target: {value: 'branches'}});
      await waitFor(() => { expect(selected()).toContain('Go to Branches of acme/website'); });
      fireEvent.keyDown(reopened, {key: 'Enter'});
      await waitFor(() => { expect(router.state.location.pathname).toBe('/acme/website/branches'); });
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  test('closing the palette gives focus back to where it was', async () => {
    await renderApp('/', signedIn());
    const issues = screen.getByRole('link', {name: /My issues/});
    issues.focus();
    key('k', {ctrlKey: true});
    const input = await screen.findByPlaceholderText(/^Search repositories, issues/);
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    fireEvent.keyDown(input, {key: 'Escape'});
    await waitFor(() => {
      expect(document.activeElement).toBe(issues);
    });
  });

  test('choosing a row in the palette leaves the focus to the new page, not to what opened it (its tooltip)', async () => {
    const {router} = await renderApp('/', signedIn());
    const issues = screen.getByRole('link', {name: /My issues/});
    issues.focus();
    key('k', {ctrlKey: true});
    const input = await screen.findByPlaceholderText(/^Search repositories, issues/);
    fireEvent.change(input, {target: {value: 'go to the inbox'}});
    await waitFor(() => {
      expect(screen.getByRole('option', {name: /Go to the inbox/})).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('option', {name: /Go to the inbox/}));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/notifications');
    });
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/^Search repositories, issues/)).toBeNull();
    });
    expect(document.activeElement).not.toBe(issues);
  });

  test('a repository page holds its group while open', async () => {
    const s = signedIn();
    const {router} = await renderApp('/acme/website/issues', s);
    expect(screen.getByRole('heading', {name: 'Issues'})).toBeTruthy();
    // GitHub's rows: the breadcrumb (with the sync indicator), the repository's tabs, then the title with the
    // list's controls — none of them in the breadcrumb's row.
    const crumbs = screen.getByRole('navigation', {name: 'Breadcrumb'});
    const tabs = screen.getByRole('navigation', {name: 'Repository'});
    const title = screen.getByRole('heading', {level: 1, name: 'Issues'});
    expect(crumbs.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tabs.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(title.closest('[data-component="PageHeader"]') ?? document.body).getByRole('button', {name: /New issue/})).toBeTruthy();
    expect(within(crumbs.parentElement ?? document.body).queryByRole('button', {name: /New issue/})).toBeNull();
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

  test('the sync indicator: nothing to see while live and up to date, the badge once something waits', async () => {
    const s = signedIn();
    const {app} = await renderApp('/', s);
    expect(screen.getByRole('status').textContent).toBe('Live');
    expect(screen.queryByRole('button', {name: /show unsynced changes/})).toBeNull();
    act(() => {
      runInAction(() => {
        app.ui.pendingIntents = 1;
      });
    });
    expect(screen.getByRole('button', {name: /show unsynced changes/}).textContent).toBe('Live· 1 pending');
    act(() => {
      runInAction(() => {
        app.ui.pendingIntents = 0;
        s.data.status.connection = 'catching_up';
      });
    });
    expect(screen.getByRole('button', {name: /show unsynced changes/}).textContent).toBe('Catching up');
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
    expect(screen.getByRole('status').textContent).toBe('Offline');
    expect(screen.getByRole('button', {name: /show unsynced changes/}).textContent).toBe('Offline· 3 pending');
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

  test('? lists every shortcut, those of this page first, and closes with its button', async () => {
    await renderApp('/', signedIn());
    key('?', {shiftKey: true});
    const dialog = await screen.findByRole('dialog', {name: 'Keyboard shortcuts'});
    expect(within(dialog).getByText('Go to my issues')).toBeTruthy();
    expect(within(dialog).getByText('Go to Home')).toBeTruthy();
    expect(within(dialog).getByText('Next item')).toBeTruthy();
    expect(within(dialog).getAllByRole('heading', {level: 2}).map((h) => h.textContent)[0]).toBe('Lists · on this page');
    fireEvent.click(within(dialog).getAllByRole('button', {name: 'Close'}).at(-1) ?? dialog);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', {name: 'Keyboard shortcuts'})).toBeNull();
    });
  });
});
