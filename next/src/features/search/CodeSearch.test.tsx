// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import type * as APIModule from '../../app/api.ts';
import {online} from '../../app/api.ts';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {fakeSession, repo, user} from '../../test/fakeSession.ts';

vi.mock('../../app/api.ts', async (original) => ({...await original<typeof APIModule>(), online: vi.fn()}));
afterEach(() => { vi.clearAllMocks(); });
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
  vi.mocked(online).mockResolvedValue({enabled: false, total: 1, repositories: {'10': 'alice/project'}, results: [{RepoID: 10, Filename: 'src/main.ts', CommitID: 'abcdef', Lines: [{Num: 7, FormattedContent: '<span>const <mark>symbol</mark> = &lt;danger&gt;</span>'}]}]});
  const router = await mount('/search?type=code&repoId=10&q=symbol');
  const row = await screen.findByRole('option', {name: 'alice/project / src/main.ts:7'});
  // The app's own code view, at the line: no rewrite of a classic address that could lose the anchor (#207).
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
});
test('the command menu on a repository page searches its code for the words typed (#208)', async () => {
  vi.mocked(online).mockResolvedValue({enabled: false, total: 0, repositories: {}, results: []});
  const router = await mount('/alice/project');
  fireEvent.keyDown(document.body, {key: 'k', ctrlKey: true});
  fireEvent.change(await screen.findByPlaceholderText(/^Search repositories, issues/), {target: {value: 'ToTile'}});
  fireEvent.click(await screen.findByRole('option', {name: 'Search code in alice/project for ToTile'}));
  await waitFor(() => { expect(router.state.location.pathname).toBe('/search'); });
  expect(router.state.location.search).toMatchObject({type: 'code', q: 'ToTile', repoId: '10'});
  await screen.findByRole('heading', {name: 'Search code in alice/project'});
});
