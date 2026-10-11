// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {test, expect} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';

test('opening a board focuses its card; arrows can enter and leave an empty column', async () => {
  const s = fakeSession();
  const owner = user(1, 'alice');
  s.data.put('User', 'profile:1', owner);
  s.data.put('Repository', 'repo:20', repo(20, owner, 'sandbox'));
  s.data.put('Issue', 'repo:20', issue(30, 20, 1, 'First card'));
  s.data.put('Project', 'profile:1', {id: 10, title: 'Board', description: '', owner_id: 1, repo_id: 0, creator_id: 1,
    closed: false, template_type: 0, card_type: 0, type: 1, created_at: T, updated_at: T});
  for (const [id, title] of [[11, 'To do'], [12, 'Empty']] as const) {
    s.data.put('ProjectColumn', 'profile:1', {id, title, project_id: 10, default: id === 11, sorting: id, color: '', creator_id: 1, created_at: T, updated_at: T});
  }
  s.data.put('ProjectIssue', 'repo:20', {id: 40, issue_id: 30, project_id: 10, column_id: 11, sorting: 0});
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/-/next/projects/10']}));
  await router.load();
  render(<App app={app} router={router}/>);
  const todo = await screen.findByRole('listbox', {name: 'To do'});
  const empty = screen.getByRole('listbox', {name: 'Empty'});
  await waitFor(() => { expect(document.activeElement).toBe(todo); });
  expect(todo.getAttribute('aria-activedescendant')).toBe('card-30');
  fireEvent.keyDown(todo, {key: 'ArrowRight'});
  await waitFor(() => { expect(document.activeElement).toBe(empty); });
  expect(app.ui.issueTarget).toEqual([]);
  fireEvent.keyDown(empty, {key: 'k', ctrlKey: true});
  fireEvent.click(await screen.findByText('Rename the column'));
  const name = await screen.findByRole('textbox', {name: 'Column name'});
  expect((name as HTMLInputElement).value).toBe('Empty');
  fireEvent.keyDown(name, {key: 'Escape'});
  await waitFor(() => { expect(document.activeElement).toBe(empty); });
  fireEvent.keyDown(empty, {key: 'ArrowLeft'});
  await waitFor(() => { expect(document.activeElement).toBe(todo); });
  expect(app.ui.issueTarget).toEqual([30]);
  fireEvent.pointerDown(screen.getByRole('button', {name: 'Column “Empty”'}), {button: 0, ctrlKey: false});
  fireEvent.click(await screen.findByRole('menuitem', {name: 'New issue in this column…'}));
  const dialog = await screen.findByRole('dialog', {name: 'New issue'});
  fireEvent.keyDown(dialog, {key: 'Escape'});
  await waitFor(() => {
    expect(document.activeElement).toBe(empty);
  });
});
