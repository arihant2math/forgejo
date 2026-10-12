// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {BaseStyles, Button, ThemeProvider} from '@primer/react';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {runInAction} from 'mobx';
import {expect, test} from 'vitest';
import {fallbackConfig} from '../../app/config.ts';
import {AppContext, createApp} from '../../app/store.ts';
import {editing} from '../../intents/editing.ts';
import {issueDeadline, issueLabelIds, issueState} from '../../intents/view.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';
import {IssuePicker, PickerPopover} from './Picker.tsx';

function fixture() {
  const session = fakeSession();
  const owner = user(1, 'alice');
  session.data.put('User', 'profile:1', owner);
  session.data.put('Repository', 'repo:20', repo(20, owner, 'demo'));
  session.data.put('Issue', 'repo:20', issue(30, 20, 7, 'Refresh docs'));
  for (const [id, name] of [[1, 'bug'], [2, 'docs']] as const) {
    session.data.put('Label', 'repo:20', {id, repo_id: 20, org_id: 0, name, exclusive: false, description: '', color: 'e11d21',
      num_issues: 0, num_closed_issues: 0, created_at: ''});
  }
  session.data.put('IssueLabel', 'repo:20', {id: 1, issue_id: 30, label_id: 2});
  const app = createApp(fallbackConfig(), session);
  const mount = (children: React.ReactNode) => render(<ThemeProvider><BaseStyles><AppContext value={app}>{children}</AppContext></BaseStyles></ThemeProvider>);
  return {session, app, mount};
}

test('anchored SelectPanel distinguishes focus from applied labels and keeps multi-selection open', async () => {
  const {mount, session, app} = fixture();
  mount(<PickerPopover kind="labels" issueIds={[30]} renderAnchor={(props) => <Button {...props}>Labels</Button>}/>);
  fireEvent.click(screen.getByRole('button', {name: 'Labels'}));
  const list = await screen.findByRole('listbox', {name: 'Change labels'});
  const bug = within(list).getByRole('option', {name: 'bug'});
  expect(list.getAttribute('aria-multiselectable')).toBe('true');
  expect(bug.getAttribute('aria-selected')).toBe('false');
  expect(within(bug).getAllByText('bug')).toHaveLength(1);
  expect(bug.textContent).toBe('bug');
  expect(within(list).getByRole('option', {name: 'docs'}).getAttribute('aria-selected')).toBe('true');
  bug.focus();
  expect(bug.getAttribute('aria-selected')).toBe('false');
  fireEvent.click(bug);
  await waitFor(() => {
    expect(issueLabelIds(session.data.pool, editing(app).overlay, 30).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(within(list).getByRole('option', {name: 'bug'}).getAttribute('aria-selected')).toBe('true');
  });
  fireEvent.click(within(list).getByRole('option', {name: 'docs'}));
  expect(issueLabelIds(session.data.pool, editing(app).overlay, 30)).toEqual([1]);
  expect(screen.getByRole('listbox', {name: 'Change labels'})).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', {name: 'Change labels'}), {target: {value: 'bug'}});
  expect(within(list).queryByRole('option', {name: 'docs'})).toBeNull();
});

test('label descriptions are muted secondary text, searchable and never interpreted as HTML', async () => {
  const {mount, session} = fixture();
  session.data.put('Label', 'repo:20', {id: 3, repo_id: 20, org_id: 0, name: '<b>security</b>', exclusive: false,
    description: '<img src=x onerror=alert(1)> Sensitive reports', color: '0052cc', num_issues: 0,
    num_closed_issues: 0, created_at: ''});
  mount(<PickerPopover kind="labels" issueIds={[30]} renderAnchor={(props) => <Button {...props}>Labels</Button>}/>);
  fireEvent.click(screen.getByRole('button', {name: 'Labels'}));
  const input = await screen.findByRole('combobox', {name: 'Change labels'});
  fireEvent.change(input, {target: {value: 'Sensitive'}});
  const option = await screen.findByRole('option', {name: '<b>security</b>'});
  expect(within(option).getAllByText('<b>security</b>')).toHaveLength(1);
  expect(within(option).getByText('<img src=x onerror=alert(1)> Sensitive reports')).toBeTruthy();
  expect(option.querySelector('b, img')).toBeNull();
  expect(screen.queryByRole('option', {name: 'bug'})).toBeNull();
});

test('shortcut modal names its target, applies a single value and returns focus', async () => {
  const {mount, app, session} = fixture();
  mount(<><button onClick={() => {runInAction(() => {app.ui.picker = {kind: 'status', issueIds: [30]};});}}>Change status</button><IssuePicker/></>);
  const anchor = screen.getByRole('button', {name: 'Change status'});
  anchor.focus();
  fireEvent.click(anchor);
  const dialog = await screen.findByRole('dialog', {name: 'Change status'});
  expect(within(dialog).getByText('#7 Refresh docs')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('option', {name: 'Closed'}));
  await waitFor(() => {expect(screen.queryByRole('dialog')).toBeNull();});
  const entity = session.data.pool.model('Issue').get(30);
  if (!entity) throw new Error('Missing issue fixture');
  expect(issueState(editing(app).overlay, entity)).toBe('closed');
  await waitFor(() => {expect(document.activeElement).toBe(anchor);});
});

test('typed due dates are not filtered out and Escape returns focus without applying', async () => {
  const {mount, app, session} = fixture();
  mount(<PickerPopover kind="due" issueIds={[30]} renderAnchor={(props) => <Button {...props}>Due date</Button>}/>);
  const anchor = screen.getByRole('button', {name: 'Due date'});
  anchor.focus();
  fireEvent.click(anchor);
  const input = await screen.findByRole('combobox', {name: 'Set the due date'});
  fireEvent.change(input, {target: {value: '2026-10-20'}});
  const choice = await screen.findByRole('option', {name: /Due Oct 20/});
  fireEvent.click(choice);
  const entity = session.data.pool.model('Issue').get(30);
  if (!entity) throw new Error('Missing issue fixture');
  expect(issueDeadline(editing(app).overlay, entity)).toBe('2026-10-20T00:00:00Z');
  fireEvent.click(anchor);
  const reopened = await screen.findByRole('combobox', {name: 'Set the due date'});
  fireEvent.change(reopened, {target: {value: '2026-10-22'}});
  act(() => {fireEvent.keyDown(reopened, {key: 'Escape'});});
  await waitFor(() => {expect(screen.queryByRole('listbox')).toBeNull();});
  expect(issueDeadline(editing(app).overlay, entity)).toBe('2026-10-20T00:00:00Z');
  await waitFor(() => {expect(document.activeElement).toBe(anchor);});
});
