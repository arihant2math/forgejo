// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {BaseStyles, ThemeProvider} from '@primer/react';
import type * as RouterModule from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {useState} from 'react';
import {afterEach, expect, test, vi} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import {AppContext, createApp} from '../../app/store.ts';
import {editing} from '../../intents/editing.ts';
import {fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';
import {IssueList} from './IssueList.tsx';
import {IssueListModel} from './list.ts';

const navigate = vi.fn().mockResolvedValue(undefined);
vi.mock('@tanstack/react-router', async (original) => ({...await original<typeof RouterModule>(),
  useNavigate: () => navigate, useRouterState: () => '/alice/demo/issues'}));
afterEach(() => {navigate.mockClear();});

function fixture(count = 3, seed?: (session: ReturnType<typeof fakeSession>) => void, pulls = false) {
  const session = fakeSession();
  const owner = user(1, 'alice');
  session.data.put('User', 'profile:1', owner);
  session.data.put('Repository', 'repo:20', repo(20, owner, 'demo'));
  session.data.put('Access', 'user:1', {id: 1, user_id: 1, repo_id: 20, permission: 'write'});
  for (let n = 1; n <= count; n++) session.data.put('Issue', 'repo:20', issue(n, 20, n, `Task ${String(n)}`));
  seed?.(session);
  const app = createApp({...fallbackConfig(), app_sub_url: ''}, session);
  const model = new IssueListModel(app, editing(app).overlay, {kind: 'repo', repoId: 20, pulls}, 'none');
  const label = pulls ? 'Pull requests' : 'Issues';
  function List() {
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
    return <main><div ref={setScroller} data-testid="issue-scroller"><IssueList model={model} scroller={scroller} empty="All clear" label={label}/></div></main>;
  }
  const mounted = render(<ThemeProvider><BaseStyles><AppContext value={app}><List/></AppContext></BaseStyles></ThemeProvider>);
  return {app, model, scroller: mounted.getByTestId('issue-scroller'), dispose: () => {mounted.unmount(); model.dispose();}};
}

test('fixed-height feature rows stay virtualized and keep real issue links', async () => {
  const {scroller, dispose} = fixture(200);
  try {
    const list = await screen.findByRole('listbox', {name: 'Issues'});
    const rows = within(list).getAllByRole('option');
    expect(rows.length).toBeLessThan(50);
    const first = within(list).getByRole('option', {name: /Task 200/});
    expect(first.getAttribute('href')).toBe('/alice/demo/issues/200');
    expect(within(first).getByTitle('Task 200').textContent).toBe('Task 200');
    expect(within(list).queryByRole('option', {name: /Task 100/})).toBeNull();
    // Reserve height for unmounted rows as well as visible ones.
    expect(list.style.height).toBe('8000px');
    fireEvent.scroll(scroller, {target: {scrollTop: 4000}});
    const later = await within(list).findByRole('option', {name: /Task 100/});
    expect(later.getAttribute('href')).toBe('/alice/demo/issues/100');
    expect(within(list).queryByRole('option', {name: /Task 200/})).toBeNull();
    expect(within(list).getAllByRole('option').length).toBeLessThan(50);
  } finally {dispose();}
});

test('keyboard cursor, range selection and row context actions retain their targets', async () => {
  const {app, model, dispose} = fixture();
  try {
    const list = await screen.findByRole('listbox', {name: 'Issues'});
    list.focus();
    fireEvent.keyDown(list, {key: 'ArrowDown'});
    expect(list.getAttribute('aria-activedescendant')).toBe('issue-row-2');
    const rows = within(list).getAllByRole('option');
    const boxes = rows.map((row) => row.querySelector<HTMLInputElement>('input[type="checkbox"]'));
    if (!boxes[0] || !boxes[2]) throw new Error('Missing row checkboxes');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[2], {shiftKey: true});
    expect(model.cursor.selected.size).toBe(3);
    expect(navigate).not.toHaveBeenCalled();
    expect(list.hasAttribute('data-selecting')).toBe(true);
    fireEvent.keyDown(list, {key: 'F10', shiftKey: true});
    fireEvent.click(await screen.findByRole('menuitem', {name: /Change labels/}));
    expect(app.ui.picker?.kind).toBe('labels');
    expect(app.ui.picker?.issueIds).toHaveLength(3);
    fireEvent.keyDown(list, {key: 'Escape'});
    expect(model.cursor.selected.size).toBe(0);
    expect(list.hasAttribute('data-selecting')).toBe(false);
    fireEvent.contextMenu(rows[1] ?? list);
    const status = await screen.findByRole('menuitem', {name: /Change status/});
    fireEvent.click(status);
    await waitFor(() => {expect(app.ui.picker?.issueIds).toEqual([2]);});
  } finally {dispose();}
});

const HEAD = 'a'.repeat(40);

function seedPulls(session: ReturnType<typeof fakeSession>, checkState: 'success' | 'failure' | 'pending' = 'success') {
  session.data.put('Label', 'repo:20', {id: 7, repo_id: 20, org_id: 0, name: 'enhancement', exclusive: false, description: '', color: 'a2eeef', num_issues: 0, num_closed_issues: 0, created_at: T});
  const pulls: [number, string, boolean][] = [[101, 'WIP: Refactor tmux popup handling', false], [102, 'Add Catppuccin themes', true]];
  for (const [id, title, checked] of pulls) {
    const number = id - 90;
    const branch = `feat-${String(number)}`;
    session.data.put('Issue', 'repo:20', issue(id, 20, number, title, {is_pull: true}));
    session.data.put('IssueLabel', 'repo:20', {id, issue_id: id, label_id: 7});
    session.data.put('PullRequest', 'repo:20', {
      id: id + 100, issue_id: id, number, status: 'mergeable', head_repo_id: 20, base_repo_id: 20, head_branch: branch, base_branch: 'main', merge_base: '',
      allow_maintainer_edit: false, merged: false, merge_commit_sha: '', merger_id: 0, commits_ahead: 1, commits_behind: 0, conflicted_files: [], flow: 0,
    });
    const sha = checked ? HEAD : 'b'.repeat(40);
    session.data.put('Branch', 'repo:20', {id, repo_id: 20, name: branch, commit_id: sha, commit_message: '', commit_time: T, pusher_id: 1, is_deleted: false, deleted_by_id: 0, created_at: T, updated_at: T});
  }
  session.data.put('CommitStatus', 'repo:20', {id: 70, repo_id: 20, sha: HEAD, index: 1, context: 'ci', state: checkState, target_url: '', description: '', creator_id: 1, created_at: T, updated_at: T});
}

test('a pull request row keeps its labels with the title and its state, checks, author and age in fixed columns', async () => {
  const {dispose} = fixture(0, seedPulls, true);
  try {
    const list = await screen.findByRole('listbox', {name: 'Pull requests'});
    const rows = within(list).getAllByRole('option');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const title = row.querySelector('.font-semibold[title]');
      const token = within(row).getByText('enhancement');
      if (!title) throw new Error('Missing row title');
      const labels = token.closest('[data-row-labels]');
      expect(labels?.parentElement).toBe(title.parentElement);
      expect(title.compareDocumentPosition(token) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const checks = row.querySelectorAll('[data-checks-slot], [title="All checks have passed"]');
      expect(checks).toHaveLength(1);
      const trailing = row.lastElementChild;
      const author = within(row).getByTitle(/^Opened by/);
      const age = within(row).getByTitle(/^Updated/);
      expect(trailing?.contains(checks[0] ?? null)).toBe(true);
      expect(trailing?.contains(token)).toBe(false);
      expect(trailing?.lastElementChild).toBe(age);
      expect([...trailing?.querySelectorAll('[data-checks-slot], [title="All checks have passed"], [title^="Opened by"], [title^="Updated"]') ?? []]).toEqual([checks[0], author, age]);
    }
    const draft = within(list).getByRole('option', {name: /WIP: Refactor/});
    const ready = within(list).getByRole('option', {name: /Catppuccin/});
    expect(within(draft).getByText('Draft')).toBeTruthy();
    expect(draft.querySelector('[data-checks-slot]')).not.toBeNull();
    expect(within(ready).getByTitle('All checks have passed')).toBeTruthy();
    expect(within(ready).getByRole('img', {name: 'All checks have passed'})).toBeTruthy();
  } finally {dispose();}
});

test.each([
  ['success', 'All checks have passed', 'text-success'],
  ['failure', 'Some checks were not successful', 'text-danger'],
  ['pending', "Some checks haven't completed yet", 'text-attention'],
] as const)('a pull request row exposes its %s check indicator as a named image', async (state, label, tone) => {
  const {dispose} = fixture(0, (session) => {seedPulls(session, state);}, true);
  try {
    const list = await screen.findByRole('listbox', {name: 'Pull requests'});
    const ready = within(list).getByRole('option', {name: /Catppuccin/});
    const indicator = within(ready).getByRole('img', {name: label});
    expect(indicator.getAttribute('title')).toBe(label);
    expect(indicator.querySelector('svg')?.classList.contains(tone)).toBe(true);
    expect(within(ready).getAllByRole('img', {name: label})).toHaveLength(1);
  } finally {dispose();}
});
