// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {BaseStyles, ThemeProvider} from '@primer/react';
import type * as RouterModule from '@tanstack/react-router';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {useState} from 'react';
import {afterEach, expect, test, vi} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import {AppContext, createApp} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';
import {IssueList} from './IssueList.tsx';
import {IssueListModel} from './list.ts';

const navigate = vi.fn().mockResolvedValue(undefined);
vi.mock('@tanstack/react-router', async (original) => ({...await original<typeof RouterModule>(),
  useNavigate: () => navigate, useRouterState: () => '/alice/demo/issues'}));
afterEach(() => {navigate.mockClear();});

function fixture(count = 3) {
  const session = fakeSession();
  const owner = user(1, 'alice');
  session.data.put('User', 'profile:1', owner);
  session.data.put('Repository', 'repo:20', repo(20, owner, 'demo'));
  session.data.put('Access', 'user:1', {id: 1, user_id: 1, repo_id: 20, permission: 'write'});
  for (let n = 1; n <= count; n++) session.data.put('Issue', 'repo:20', issue(n, 20, n, `Task ${String(n)}`));
  const app = createApp({...fallbackConfig(), app_sub_url: ''}, session);
  const model = new IssueListModel(app, editing(app).overlay, {kind: 'repo', repoId: 20, pulls: false}, 'none');
  function List() {
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
    return <main><div ref={setScroller} data-testid="issue-scroller"><IssueList model={model} scroller={scroller} empty="All clear" label="Issues"/></div></main>;
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
    // Truncated titles keep a native full-title hint without per-row tooltip overlays.
    expect(within(first).getByTitle('Task 200').textContent).toBe('Task 200');
    expect(within(list).queryByRole('option', {name: /Task 100/})).toBeNull();
    // A fixed-height list reserves 40px per issue, not just per mounted row. Scrolling brings
    // previously unmounted issues into view without depending on a containment utility's spelling.
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
