// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {configure, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {test, expect, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import {issueProject} from '../../intents/view.ts';
import {fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';

// Dialog exit animations and multi-step tests need longer timeouts under load.
configure({asyncUtilTimeout: 10_000});
vi.setConfig({testTimeout: 30_000});

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
  fireEvent.keyDown(todo, {key: 'F10', shiftKey: true});
  const keyboardMenu = await screen.findByRole('menu');
  expect(within(keyboardMenu).getByText('Open', {exact: true})).toBeTruthy();
  fireEvent.keyDown(keyboardMenu, {key: 'Escape'});
  await waitFor(() => { expect(document.activeElement).toBe(todo); });
  expect(fireEvent.contextMenu(todo, {clientX: 120, clientY: 160})).toBe(false);
  const pointerMenu = await screen.findByRole('menu');
  expect(within(pointerMenu).getByText('Move to', {exact: true})).toBeTruthy();
  fireEvent.keyDown(pointerMenu, {key: 'Escape'});
  await waitFor(() => { expect(document.activeElement).toBe(todo); });
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
  fireEvent.click(screen.getByRole('button', {name: 'Column “Empty”'}));
  fireEvent.click(await screen.findByRole('menuitem', {name: 'New issue in this column…'}));
  const dialog = await screen.findByRole('dialog', {name: 'New issue'});
  fireEvent.keyDown(dialog, {key: 'Escape'});
  await waitFor(() => {
    expect(document.activeElement).toBe(empty);
  });
});

test('adding existing issues: no "Add 0" row, what is picked is added, typed text that matches nothing offers a new issue in the column', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', {status: 200, headers: {'Content-Type': 'application/json'}}))));
  const s = fakeSession();
  const owner = user(1, 'alice');
  s.data.put('User', 'profile:1', owner);
  s.data.put('Repository', 'repo:20', repo(20, owner, 'sandbox'));
  s.data.put('Issue', 'repo:20', issue(30, 20, 1, 'First card'));
  s.data.put('Issue', 'repo:20', issue(31, 20, 2, 'Tile docs refresh'));
  s.data.put('Project', 'profile:1', {id: 10, title: 'Board', description: '', owner_id: 1, repo_id: 0, creator_id: 1,
    closed: false, template_type: 0, card_type: 0, type: 1, created_at: T, updated_at: T});
  s.data.put('ProjectColumn', 'profile:1', {id: 11, title: 'Backlog', project_id: 10, default: true, sorting: 1, color: '', creator_id: 1, created_at: T, updated_at: T});
  s.data.put('ProjectIssue', 'repo:20', {id: 40, issue_id: 30, project_id: 10, column_id: 11, sorting: 0});
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/-/next/projects/10']}));
  await router.load();
  render(<App app={app} router={router}/>);
  const backlog = await screen.findByRole('listbox', {name: 'Backlog'});
  await waitFor(() => { expect(document.activeElement).toBe(backlog); });
  expect(screen.getByRole('button', {name: 'New issue in “Backlog”'})).toBeTruthy();

  fireEvent.click(screen.getByRole('button', {name: 'Add existing issue…'}));
  const picker = await screen.findByRole('dialog', {name: 'Add existing issues'});
  expect(within(picker).getByText('Cards are issues: pick existing ones, or create a new issue in this column.')).toBeTruthy();
  const names = () => within(screen.getByRole('dialog', {name: 'Add existing issues'})).getAllByRole('option').map((o) => o.textContent);
  expect(names().some((n) => n?.includes('Add 0'))).toBe(false);
  expect(names()).toEqual([expect.stringContaining('Tile docs refresh'), 'New issue in this column…']);
  fireEvent.click(within(picker).getByRole('option', {name: /Tile docs refresh/}));
  fireEvent.click(await within(picker).findByRole('option', {name: 'Add 1 selected issue'}));
  await waitFor(() => { expect(screen.queryByRole('dialog', {name: 'Add existing issues'})).toBeNull(); });
  expect(issueProject(s.data.pool, editing(app).overlay, 31)).toEqual({project: 10, column: 11});
  // Wait for the focus-restoration frame before reopening the dialog.
  await new Promise((r) => { setTimeout(r, 50); });
  expect(document.activeElement).toBe(backlog);

  fireEvent.click(screen.getByRole('button', {name: 'Add existing issue…'}));
  const input = await screen.findByRole('combobox', {name: 'Search existing issues'});

  fireEvent.change(input, {target: {value: 'Placeholder: tile docs refresh'}});
  expect(await screen.findByText(/^No issue (on this device )?matches$/)).toBeTruthy();
  expect(names()).toEqual(['New issue “Placeholder: tile docs refresh” in this column…']);
  fireEvent.keyDown(input, {key: 'Enter'});
  fireEvent.keyPress(input, {key: 'Enter', charCode: 13});
  await waitFor(() => { expect(app.ui.create).toEqual({repoId: 20, board: {projectId: 10, columnId: 11}, title: 'Placeholder: tile docs refresh'}); });
  expect(screen.queryByRole('dialog', {name: 'Add existing issues'})).toBeNull();
  const dialog = await screen.findByRole('dialog', {name: 'New issue'});
  fireEvent.keyDown(dialog, {key: 'Escape'});
  await waitFor(() => { expect(document.activeElement).toBe(backlog); });
  vi.unstubAllGlobals();
});

test('a card from the board in three keys: typed text that matches no issue, Enter, then ⌘↵ makes that issue in the column', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', {status: 200, headers: {'Content-Type': 'application/json'}}))));
  const s = fakeSession({userId: 1});
  const owner = user(1, 'alice');
  s.data.put('User', 'profile:1', owner);
  s.data.put('Repository', 'repo:20', repo(20, owner, 'sandbox'));
  s.data.put('Access', 'user:1', {id: 1, repo_id: 20, user_id: 1, permission: 'write'});
  s.data.put('Project', 'repo:20', {id: 10, title: 'Board', description: '', owner_id: 1, repo_id: 20, creator_id: 1,
    closed: false, template_type: 0, card_type: 0, type: 2, created_at: T, updated_at: T});
  for (const [id, title] of [[11, 'Backlog'], [12, 'Doing']] as const) {
    s.data.put('ProjectColumn', 'repo:20', {id, title, project_id: 10, default: id === 11, sorting: id, color: '', creator_id: 1, created_at: T, updated_at: T});
  }
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/-/next/projects/10']}));
  await router.load();
  render(<App app={app} router={router}/>);
  const doing = await screen.findByRole('listbox', {name: 'Doing'});
  // Let the board's initial focus frames finish before opening a dialog.
  await new Promise((r) => { setTimeout(r, 50); });
  const submit = vi.spyOn(editing(app).intents, 'submit');
  fireEvent.click(screen.getAllByRole('button', {name: 'Add existing issue…'})[1] as HTMLElement);
  const input = await screen.findByRole('combobox', {name: 'Search existing issues'});
  fireEvent.change(input, {target: {value: 'Quick note check'}});
  await screen.findByRole('option', {name: 'New issue “Quick note check” in this column…'});
  fireEvent.keyDown(input, {key: 'Enter'});
  fireEvent.keyPress(input, {key: 'Enter', charCode: 13});
  const title = await screen.findByRole<HTMLInputElement>('textbox', {name: 'Title'});
  expect(title.value).toBe('Quick note check');
  expect(screen.getByText(/On Board · Doing/)).toBeTruthy();
  fireEvent.keyDown(title, {key: 'Enter', ctrlKey: true});
  await waitFor(() => { expect(app.ui.create).toBeUndefined(); });
  const created = submit.mock.calls.map(([i]) => i).find((i) => i.kind === 'issue.create');
  expect(created).toMatchObject({kind: 'issue.create', repoId: 20, title: 'Quick note check'});
  expect(submit.mock.calls.map(([i]) => i).find((i) => i.kind === 'issue.project')).toMatchObject({kind: 'issue.project', issueId: created?.issueId, projectId: 10, columnId: 12});
  await waitFor(() => { expect(document.activeElement).toBe(doing); });
  vi.unstubAllGlobals();
});

test('deleting a column asks first: Cancel has focus, Escape returns to the column, Delete sends the deletion', async () => {
  const s = fakeSession();
  const owner = user(1, 'alice');
  s.data.put('User', 'profile:1', owner);
  s.data.put('Project', 'profile:1', {id: 10, title: 'Board', description: '', owner_id: 1, repo_id: 0, creator_id: 1,
    closed: false, template_type: 0, card_type: 0, type: 1, created_at: T, updated_at: T});
  for (const [id, title] of [[11, 'To do'], [12, 'Empty']] as const) {
    s.data.put('ProjectColumn', 'profile:1', {id, title, project_id: 10, default: id === 11, sorting: id, color: '', creator_id: 1, created_at: T, updated_at: T});
  }
  s.auth.token = () => Promise.resolve('token');
  const sent: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    sent.push(`${init?.method ?? 'GET'} ${new URL(url, 'http://localhost').pathname}`);
    return Promise.resolve(new Response('{}', {status: 200, headers: {'Content-Type': 'application/json'}}));
  }));
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, s);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: ['/-/next/projects/10']}));
  await router.load();
  render(<App app={app} router={router}/>);
  const empty = await screen.findByRole('listbox', {name: 'Empty'});
  const ask = async () => {
    fireEvent.click(screen.getByRole('button', {name: 'Column “Empty”'}));
    fireEvent.click(await screen.findByRole('menuitem', {name: 'Delete…'}));
    return screen.findByRole('alertdialog', {name: 'Delete “Empty”?'});
  };
  let dialog = await ask();
  expect(dialog.textContent).toContain('Its cards move to the default column.');
  await waitFor(() => { expect(document.activeElement).toBe(within(dialog).getByRole('button', {name: 'Cancel'})); });
  fireEvent.keyDown(document.activeElement ?? document.body, {key: 'Escape'});
  await waitFor(() => { expect(document.activeElement).toBe(empty); });
  expect(sent.filter((r) => r.startsWith('DELETE'))).toEqual([]);
  dialog = await ask();
  fireEvent.click(within(dialog).getByRole('button', {name: 'Delete'}));
  await waitFor(() => { expect(sent).toContain('DELETE /-/sync/api/projects/10/columns/12'); });
  vi.unstubAllGlobals();
});
