// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import type * as APIModule from '../../app/api.ts';
import {online} from '../../app/api.ts';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {CodeSource} from '../../code/source.ts';
import {fakeSession, repo, user} from '../../test/fakeSession.ts';

vi.mock('../../app/api.ts', async (original) => ({...await original<typeof APIModule>(), online: vi.fn()}));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
async function mount(path: string) {
  const session = fakeSession();
  const alice = user(1, 'alice');
  session.data.put('User', 'profile:1', alice);
  session.data.put('Repository', 'repo:10', repo(10, alice, 'project'));
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, session);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return router;
}
test('repository results contain safe highlighted text and commit-pinned line links', async () => {
  vi.mocked(online).mockResolvedValue({enabled: false, total: 1, repositories: {'10': 'alice/project'}, results: [{RepoID: 10, Filename: 'src/main.ts', CommitID: 'abcdef', Lines: [{Num: 7, FormattedContent: '<span>const <span class="search-highlight">symbol</span> = &lt;danger&gt;</span>'}]}]});
  const router = await mount('/search?type=code&repoId=10&q=symbol');
  const row = await screen.findByRole('option', {name: 'alice/project / src/main.ts:7'});
  // Link directly to the code view so classic-address rewriting cannot lose the line anchor.
  expect(row.getAttribute('href')).toBe('/alice/project/src/commit/abcdef/src/main.ts#L7');
  fireEvent.click(row);
  await waitFor(() => { expect(router.state.location.pathname).toBe('/alice/project/src/commit/abcdef/src/main.ts'); });
  expect(router.state.location.hash).toBe('L7');
  router.history.back();
  await screen.findByRole('option', {name: 'alice/project / src/main.ts:7'});
  expect(screen.getByText('symbol').tagName).toBe('MARK');
  expect(screen.getByText(/<danger>/).textContent).toContain('<danger>');
  expect(vi.mocked(online).mock.calls[0]?.[1].path).toContain('/repos/10/search?');
  fireEvent.click(screen.getByRole('button', {name: 'Search all repositories'}));
  await waitFor(() => { expect(router.state.location.search.repoId).toBeUndefined(); });
});
test('global search explains a disabled code indexer', async () => {
  vi.mocked(online).mockResolvedValue({enabled: false, total: 0, results: []});
  await mount('/search?type=code&q=symbol');
  await screen.findByText('Global code search is unavailable');
  const nav = screen.getByRole('navigation', {name: 'Search type'});
  expect(within(nav).getByRole('link', {name: /^Code/}).getAttribute('aria-current')).toBe('page');
  expect(within(nav).getByRole('link', {name: 'Issues'}).getAttribute('href')).toMatch(/\/search\?q=symbol&type=issues$/);
  expect(screen.queryByRole('button', {name: 'All search types'})).toBeNull();
});
test('the command menu on a repository page searches its code for the words typed (#208)', async () => {
  vi.mocked(online).mockResolvedValue({enabled: false, total: 0, repositories: {}, results: []});
  const router = await mount('/alice/project');
  fireEvent.keyDown(document.body, {key: 'k', ctrlKey: true});
  fireEvent.change(await screen.findByPlaceholderText(/^Search or jump to/), {target: {value: 'ToTile'}});
  fireEvent.click(await screen.findByRole('option', {name: 'Search code in alice/project for ToTile'}));
  await waitFor(() => { expect(router.state.location.pathname).toBe('/search'); });
  expect(router.state.location.search).toMatchObject({type: 'code', q: 'ToTile', repoId: '10'});
  await screen.findByRole('heading', {name: 'Search code in alice/project'});
});

test('only matching lines are results; context is shown in its hit, and the keys move over hits only (#248)', async () => {
  const hl = (w: string) => `<span class="search-highlight">${w}</span>`;
  vi.mocked(online).mockResolvedValue({enabled: false, total: 2, repositories: {'10': 'alice/project'}, results: [
    {RepoID: 10, Filename: 'config.go', CommitID: 'abc', Lines: [
      {Num: 16, FormattedContent: 'func Default() Config {'}, {Num: 17, FormattedContent: `\treturn Config{Max${hl('Zoom')}: 16}`}, {Num: 18, FormattedContent: '}'},
    ]},
    {RepoID: 10, Filename: 'projection.go', CommitID: 'abc', Lines: [
      {Num: 17, FormattedContent: ''}, {Num: 18, FormattedContent: `func clamp(${hl('zoom')} int) int {`}, {Num: 19, FormattedContent: '\treturn 0'},
    ]},
  ]});
  const router = await mount('/search?type=code&repoId=10&q=zoom');
  await screen.findByRole('option', {name: 'alice/project / config.go:17'});
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['alice/project / config.go:17', 'alice/project / projection.go:18']);
  const context = screen.getByText('func Default() Config {');
  expect(context.closest('a')).toBe(screen.getByText('Zoom').closest('a'));
  expect(context.closest('mark')).toBeNull();
  expect(screen.getByText('Zoom').tagName).toBe('MARK');
  const list = screen.getByRole('listbox', {name: 'Code search results'});
  fireEvent.keyDown(list, {key: 'ArrowDown'});
  fireEvent.keyDown(list, {key: 'ArrowDown'});
  expect(screen.getByRole('option', {name: 'alice/project / projection.go:18'}).getAttribute('aria-selected')).toBe('true');
  fireEvent.keyDown(list, {key: 'Enter'});
  await waitFor(() => { expect(router.state.location.pathname).toBe('/alice/project/src/commit/abc/projection.go'); });
  expect(router.state.location.hash).toBe('L18');
});

test('a hit and its context are highlighted together by the file\'s language, the match marked over the colours', async () => {
  const snippet = vi.spyOn(CodeSource.prototype, 'snippet').mockImplementation((_lang, text) => {
    // Each line's first word as a keyword.
    const lines = text.split('\n');
    return Promise.resolve({
      spans: Uint32Array.from(lines.flatMap((l) => { const w = /^\S*/.exec(l)?.[0].length ?? 0; return [w, 1, l.length - w, 0]; })),
      starts: Uint32Array.from(lines.map((_, i) => 2 * i).concat(2 * lines.length)),
    });
  });
  vi.mocked(online).mockResolvedValue({enabled: false, total: 1, repositories: {'10': 'alice/project'}, results: [{RepoID: 10, Filename: 'src/main.ts', CommitID: 'abc', Lines: [
    {Num: 6, FormattedContent: 'export {}'}, {Num: 7, FormattedContent: '<span class="search-highlight">const</span> symbol = 1'},
  ]}]});
  await mount('/search?type=code&repoId=10&q=const');
  await waitFor(() => { expect(screen.getByText('export').classList.contains('text-syntax-keyword')).toBe(true); });
  expect(snippet).toHaveBeenCalledWith('typescript', 'export {}\nconst symbol = 1', expect.any(AbortSignal));
  const match = screen.getByText('const');
  expect(match.classList.contains('text-syntax-keyword')).toBe(true);
  expect(match.parentElement?.tagName).toBe('MARK');
});
test('a failed search says what failed without the server’s internals', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const {RequestFailed} = await vi.importActual<typeof APIModule>('../../app/api.ts');
  vi.mocked(online).mockRejectedValue(new RequestFailed(500, 'dial tcp 10.0.0.7:9200: connect: connection refused'));
  await mount('/search?type=code&repoId=10&q=symbol');
  expect(await screen.findByText('Forgejo ran into an error. Try again in a moment.')).toBeTruthy();
  expect(screen.queryByText(/10\.0\.0\.7/)).toBeNull();
});
