// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, describe, expect, onTestFinished, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {CodeSource, codeSource} from '../../code/source.ts';
import type {APITree, Branch, NextConfig, Release} from '../../protocol/types.gen.ts';
import {classConflicts} from '../../test/conflicts.ts';
import {fakeSession, repo, T, user} from '../../test/fakeSession.ts';

// The file list warms the highlighter when idle (also after a test ended): jsdom has no Worker.
vi.spyOn(CodeSource.prototype, 'preheat').mockImplementation(() => undefined);

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const SHA = 'a'.repeat(40);

const base: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

function branch(id: number, name: string, commit: string): Branch {
  return {id, repo_id: 20, name, commit_id: commit, commit_message: '', commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T};
}

function release(id: number, tag: string, extra: Partial<Release> = {}): Release {
  return {
    id, repo_id: 20, publisher_id: 1, tag_name: tag, target_commitish: 'main', name: '', sha: String(id).padStart(40, '0'), body: '', body_html: '',
    draft: false, prerelease: false, is_tag: true, num_commits: 0, hide_archive_links: false, original_author: '', created_at: T, ...extra,
  };
}

function session() {
  const s = fakeSession({workspace: {viewer_id: 1, truncated: false, max_repos: 200, groups: [{group: 'repo:20', units: [], reason: 'member'}]}});
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  s.data.put('Branch', 'repo:20', branch(1, 'main', SHA));
  s.data.put('Release', 'repo:20', release(1, 'v1.0.0'));
  s.data.put('Release', 'repo:20', release(2, 'v1.1.0', {is_tag: false}));
  // A draft has no tag yet: not counted.
  s.data.put('Release', 'repo:20', release(3, 'v2.0.0', {draft: true, sha: ''}));
  s.auth.token = () => Promise.resolve('token');
  return s;
}

async function renderHome(cfg: NextConfig = base, opts: {paths?: string[]} = {}) {
  const app = createApp(cfg, session());
  const src = codeSource(app);
  if (!src) throw new Error('no code source');
  const tree: APITree = {commit: SHA, path: '', sha: 'b'.repeat(40), entries: [{name: 'README.md', type: 'blob', mode: '100644', sha: 'd'.repeat(40), size: 100}]};
  src.cache.put(CodeSource.treeKey(20, SHA, ''), tree);
  if (opts.paths) src.cache.put(CodeSource.pathsKey(20, SHA), {paths: opts.paths, truncated: false});
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/acme/website']}));
  await router.load();
  const r = render(<App app={app} router={router}/>);
  await screen.findByRole('button', {name: 'Ref: main'});
  return {app, router, src, ...r};
}

describe('the overview\'s file bar', () => {
  test('the branch picker, branches and tags on the left; Go to file and Code on the right, at once', async () => {
    const {container} = await renderHome();
    expect(screen.getByRole('link', {name: '1 branch'}).getAttribute('href')).toBe('/-/next/code/acme/website/branches/-');
    expect(screen.getByRole('link', {name: '2 tags'}).getAttribute('href')).toBe('/-/next/code/acme/website/tags/-');
    const find = screen.getByRole('button', {name: 'Go to file'});
    const code = screen.getByRole('button', {name: 'Code'});
    // GitHub's green button (Button variant success).
    expect(code.className).toContain('bg-success-solid');
    expect(screen.getByRole('link', {name: '2 tags'}).compareDocumentPosition(find) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(find.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Above the files panel, not in it.
    const files = screen.getByRole('region', {name: 'Files'});
    expect(files.contains(code)).toBe(false);
    expect(classConflicts(container)).toEqual([]);
  });

  test('Code: the HTTPS clone URL with a copy button, the archives; no SSH tab when the instance has none', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true});
    onTestFinished(() => {
      Reflect.deleteProperty(navigator, 'clipboard');
    });
    await renderHome();
    fireEvent.click(screen.getByRole('button', {name: 'Code'}));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', {name: 'Clone URL (HTTPS)'}).value).toBe('http://localhost/acme/website.git');
    expect(within(dialog).queryByRole('radio', {name: 'SSH'})).toBeNull();
    const zip = within(dialog).getByRole('link', {name: 'Download ZIP'});
    expect(zip.getAttribute('href')).toBe('/acme/website/archive/main.zip');
    expect(zip.hasAttribute('download')).toBe(true);
    expect(within(dialog).getByRole('link', {name: 'Download TAR.GZ'}).getAttribute('href')).toBe('/acme/website/archive/main.tar.gz');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', {name: 'Copy the clone URL'}));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('http://localhost/acme/website.git');
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  test('Code: HTTPS and SSH tabs when the instance has SSH', async () => {
    await renderHome({...base, ssh_clone_prefix: 'ssh://git@localhost:2222/'});
    fireEvent.click(screen.getByRole('button', {name: 'Code'}));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', {name: 'SSH'}));
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', {name: 'Clone URL (SSH)'}).value).toBe('ssh://git@localhost:2222/acme/website.git');
    expect(within(dialog).getByText('Use a password-protected SSH key.')).toBeTruthy();
  });

  test('Go to file: T opens it; the paths are found by fuzzy match and open in the code view', async () => {
    // The file view it opens highlights the file: no workers here.
    vi.stubGlobal('Worker', class {
      addEventListener = () => undefined;
      removeEventListener = () => undefined;
      postMessage = () => undefined;
      terminate = () => undefined;
    });
    const {router, src} = await renderHome(base, {paths: ['docs/guide.md', 'README.md', 'src/app/App.tsx', 'src/readme_parser.go']});
    const blob = vi.spyOn(src, 'blob').mockResolvedValue({kind: 'text', text: '# Website', size: 9});
    const highlight = vi.spyOn(src, 'highlight').mockResolvedValue(null);
    act(() => {
      fireEvent.keyDown(document.body, {key: 't'});
    });
    const input = await screen.findByPlaceholderText('Go to file…');
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    // Every file before typing; then the matches, best first (the name's start beats a match over directories).
    expect(screen.getAllByRole('option')).toHaveLength(4);
    fireEvent.change(input, {target: {value: 'rdme'}});
    await waitFor(() => {
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['README.md', 'src/readme_parser.go']);
    });
    // The highlighted result is fetched and highlighted ahead (idle), from its entry in the cached root tree.
    await waitFor(() => {
      expect(blob).toHaveBeenCalledWith(20, 'd'.repeat(40), 'README.md', 100);
    });
    await waitFor(() => {
      expect(highlight).toHaveBeenCalledWith(20, 'd'.repeat(40), 'README.md', '# Website', 'idle');
    });
    fireEvent.keyDown(input, {key: 'Enter'});
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/-/next/code/acme/website/src/branch/main/README.md/-');
    });
  });

  test('Go to file asks for the recursive tree on intent, every page, once per commit', async () => {
    const pages: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      pages.push(input);
      const page = Number(new URL(input, 'http://localhost').searchParams.get('page'));
      const entry = (p: string, type = 'blob') => ({path: p, type, mode: '100644', sha: 'f'.repeat(40), size: 1, url: ''});
      const tree = page === 1 ? [entry('src', 'tree'), entry('src/a.ts')] : page === 2 ? [entry('src/b.ts'), entry('src/c.ts')] : [entry('z.md')];
      return Promise.resolve(new Response(JSON.stringify({sha: SHA, url: '', tree, truncated: true, page, total_count: 5}), {headers: {'Content-Type': 'application/json'}}));
    }));
    const {src} = await renderHome();
    fireEvent.pointerEnter(screen.getByRole('button', {name: 'Go to file'}));
    fireEvent.focus(screen.getByRole('button', {name: 'Go to file'}));
    await waitFor(() => {
      expect(src.peek(CodeSource.pathsKey(20, SHA))).toEqual({paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'z.md'], truncated: false});
    });
    const trees = pages.filter((u) => u.includes('/git/trees/'));
    expect(trees.map((u) => new URL(u, 'http://localhost').searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(trees[0]).toContain(`/api/v1/repos/acme/website/git/trees/${SHA}?recursive=true`);
  });
});
