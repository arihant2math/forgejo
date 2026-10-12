// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {runInAction} from 'mobx';
import {afterEach, expect, test, vi} from 'vitest';
import type * as ApiModule from '../../app/api.ts';
import {onlineWrite} from '../../app/api.ts';
import {App} from '../../app/App.tsx';
import {connectivity} from '../../app/online.ts';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {fakeSession, T, user} from '../../test/fakeSession.ts';

vi.mock('../../app/api.ts', async (original) => ({...await original<typeof ApiModule>(), onlineWrite: vi.fn()}));
afterEach(() => { vi.clearAllMocks(); runInAction(() => { connectivity.online = true; }); });

async function boardPage(path: string) {
  const s = fakeSession();
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('Project', 'profile:1', {id: 10, title: 'Planning', description: 'Old description', owner_id: 1, repo_id: 0, creator_id: 1,
    closed: false, template_type: 0, card_type: 0, type: 1, created_at: T, updated_at: T});
  s.data.put('Project', 'profile:1', {id: 11, title: 'Done', description: '', owner_id: 1, repo_id: 0, creator_id: 1,
    closed: true, template_type: 0, card_type: 0, type: 1, created_at: T, updated_at: T});
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return s;
}

test('board settings edits and clears the description through livesync, and is disabled offline', async () => {
  vi.mocked(onlineWrite).mockResolvedValue({value: undefined, syncId: 2, totalCount: undefined});
  await boardPage('/-/next/projects/10');
  const settings = await screen.findByRole('button', {name: 'Board settings'});
  fireEvent.click(settings);
  fireEvent.click(await screen.findByRole('menuitem', {name: 'Edit board'}));
  fireEvent.change(await screen.findByRole('textbox', {name: 'Title'}), {target: {value: 'Renamed'}});
  fireEvent.change(screen.getByRole('textbox', {name: /Description/}), {target: {value: ''}});
  fireEvent.click(screen.getByRole('button', {name: 'Save changes'}));
  await waitFor(() => { expect(onlineWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({method: 'PATCH', api: 'sync', path: '/projects/10', body: {title: 'Renamed', description: '', card_type: 'text_only'}})); });
  await waitFor(() => { expect(screen.queryByRole('dialog', {name: 'Edit board'})).toBeNull(); });
  runInAction(() => { connectivity.online = false; });
  await waitFor(() => { expect((settings as HTMLButtonElement).disabled).toBe(true); });
  fireEvent.click(settings);
  expect(screen.queryByRole('menuitem', {name: 'Edit board'})).toBeNull();
  expect(screen.getByText(/Changing a board.*not queued offline/)).toBeTruthy();
});

test('creation uses template and scope, and a delayed sync retry does not create twice', async () => {
  vi.mocked(onlineWrite).mockResolvedValue({value: {id: 10}, syncId: 2, totalCount: undefined});
  const s = await boardPage('/-/next/boards');
  vi.spyOn(s.data, 'whenSynced').mockRejectedValueOnce(new Error('Sync timed out')).mockResolvedValue(undefined);
  const create = (await screen.findAllByRole('button', {name: 'New board'}))[0];
  if (!create) throw new Error('New board button is missing');
  fireEvent.click(create);
  fireEvent.change(await screen.findByRole('textbox', {name: 'Title'}), {target: {value: 'Triage'}});
  fireEvent.click(screen.getByRole('button', {name: 'Bug triage'}));
  fireEvent.click(screen.getByRole('button', {name: 'Create board'}));
  await screen.findByText('Board created; sync is still catching up');
  expect(onlineWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({method: 'POST', path: '/projects', body: {repo_id: 0, owner_id: 1, title: 'Triage', description: '', card_type: 'text_only', template_type: 'bug_triage'}}));
  fireEvent.click(screen.getByRole('button', {name: 'Open board'}));
  await screen.findByRole('button', {name: 'Board settings'});
  expect(onlineWrite).toHaveBeenCalledTimes(1);
});

test('boards list separates closed boards and offers creation even without an open board', async () => {
  await boardPage('/-/next/boards');
  await screen.findByRole('link', {name: 'Planning'});
  expect(screen.queryByRole('link', {name: 'Done'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Closed'}));
  await screen.findByRole('link', {name: 'Done'});
  expect(screen.queryByRole('link', {name: 'Planning'})).toBeNull();
  const create = screen.getAllByRole('button', {name: 'New board'})[0];
  if (!create) throw new Error('New board button is missing');
  fireEvent.click(create);
  await screen.findByRole('dialog', {name: 'New board'});
  expect(screen.getByRole('textbox', {name: 'Title'})).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Bug triage'})).toBeTruthy();
});
