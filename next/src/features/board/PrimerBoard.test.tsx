// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {BaseStyles, ThemeProvider} from '@primer/react';
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {runInAction} from 'mobx';
import {useState, type ReactElement} from 'react';
import type * as RouterModule from '@tanstack/react-router';
import {afterEach, expect, test, vi} from 'vitest';
import type * as ApiModule from '../../app/api.ts';
import {onlineWrite} from '../../app/api.ts';
import {connectivity} from '../../app/online.ts';
import {AppContext, createApp} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import {issueProject} from '../../intents/view.ts';
import {fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';

import {LabelsCell} from '../issues/cells.tsx';
import {AddExisting} from './AddExisting.tsx';
import {BoardCard, BoardColumn} from './BoardParts.tsx';
import {BoardPage} from './BoardView.tsx';
import {BoardModel} from './model.ts';
import {CARD_HEIGHT, SLOT} from './geometry.ts';
import {BoardSettings, NewBoard} from './ProjectDialogs.tsx';

vi.mock('@tanstack/react-router', async (original) => ({...await original<typeof RouterModule>(), useNavigate: () => vi.fn().mockResolvedValue(undefined), useParams: () => ({id: '10'}), useSearch: () => undefined}));
vi.mock('../../components/Crumbs.tsx', () => ({Crumbs: ({crumbs}: {crumbs: {label: string}[]}) => <span>{crumbs.map((c) => c.label).join(' / ')}</span>}));
vi.mock('../../app/api.ts', async (original) => ({...await original<typeof ApiModule>(), onlineWrite: vi.fn()}));
afterEach(() => { vi.clearAllMocks(); runInAction(() => { connectivity.online = true; }); });

function fixture() {
  const s = fakeSession();
  const owner = user(1, 'alice');
  s.data.put('User', 'profile:1', owner);
  s.data.put('Repository', 'repo:20', repo(20, owner, 'sandbox'));
  s.data.put('Issue', 'repo:20', issue(30, 20, 1, 'Refresh docs'));
  s.data.put('Project', 'profile:1', {id: 10, title: 'Planning', description: '', owner_id: 1, repo_id: 0, creator_id: 1,
    closed: false, template_type: 0, card_type: 0, type: 1, created_at: T, updated_at: T});
  s.data.put('ProjectColumn', 'profile:1', {id: 11, title: 'Backlog', project_id: 10, default: true, sorting: 0, color: '', creator_id: 1, created_at: T, updated_at: T});
  const app = createApp({app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null}, s);
  const project = s.data.pool.model('Project').get(10);
  if (!project) throw new Error('Missing project fixture');
  const mount = (child: ReactElement) => render(<ThemeProvider><BaseStyles><AppContext value={app}>{child}</AppContext></BaseStyles></ThemeProvider>);
  return {s, app, project, mount};
}

test('Primer lanes retain fixed-height, contained, selected link cards and named lists', () => {
  const {mount} = fixture();
  mount(<BoardColumn title="Backlog" count={1} columnId={11}>
    <div role="listbox" aria-label="Backlog"><BoardCard href="/alice/sandbox/issues/1" active dragging meta="#1" title="Refresh docs"/></div>
  </BoardColumn>);
  const heading = screen.getByRole('heading', {name: 'Backlog'});
  expect(heading.tagName).toBe('H2');
  expect(heading.classList.contains('text-base')).toBe(true);
  const card = within(screen.getByRole('listbox', {name: 'Backlog'})).getByRole('option');
  expect(card.getAttribute('href')).toBe('/alice/sandbox/issues/1');
  expect(card.getAttribute('aria-selected')).toBe('true');
  expect(card.hasAttribute('data-dragging')).toBe(true);
  expect(card.style.height).toBe(`${String(CARD_HEIGHT)}px`);
  expect(CARD_HEIGHT).toBe(104);
  expect(SLOT).toBe(CARD_HEIGHT + 8);
  expect(card.classList.contains('contain-content')).toBe(true);
  expect(card.classList.contains('py-1')).toBe(true);
  expect(card.firstElementChild?.classList.contains('h-5')).toBe(true);
});

test('two-line titles reserve 40px and keep labels in a separate, contained single line', () => {
  const {s, mount} = fixture();
  for (const [index, name] of ['bug', 'enhancement', 'good first issue'].entries()) {
    const id = index + 1;
    s.data.put('Label', 'repo:20', {id, repo_id: 20, org_id: 0, name, exclusive: false, description: '', color: 'e11d21',
      num_issues: 0, num_closed_issues: 0, created_at: T});
    s.data.put('IssueLabel', 'repo:20', {id, issue_id: 30, label_id: id});
  }
  const cardIssue = s.data.pool.model('Issue').get(30);
  if (!cardIssue) throw new Error('Missing issue fixture');
  const title = 'Preview window flickers when resizing the terminal in tmux';
  mount(<BoardCard meta="#1" title={title} footer={<LabelsCell issue={cardIssue} max={2}/>}/>);
  const titleRow = screen.getByText(title);
  for (const name of ['clamp-title', 'h-10', 'shrink-0']) {
    expect(titleRow.classList.contains(name)).toBe(true);
  }
  const labelsRow = titleRow.nextElementSibling;
  for (const name of ['mt-2', 'h-5', 'shrink-0', 'overflow-hidden', 'whitespace-nowrap']) {
    expect(labelsRow?.classList.contains(name)).toBe(true);
  }
  expect(screen.getByText('bug')).toBeTruthy();
  expect(screen.getByText('enhancement')).toBeTruthy();
  expect(screen.getByText('+1').getAttribute('title')).toBe('good first issue');
});

test('SelectPanel adds picked issues offline and offers a typed new issue with Enter', async () => {
  runInAction(() => { connectivity.online = false; });
  const {mount, project, app, s} = fixture();
  const model = new BoardModel(app, project.id);
  const create = vi.fn();
  function Picker() {
    const [open, setOpen] = useState(true);
    return open ? <AddExisting project={project} model={model} columnId={11} onClose={() => { setOpen(false); }} onCreate={create}/> : <button onClick={() => { setOpen(true); }}>Reopen</button>;
  }
  mount(<Picker/>);
  const dialog = await screen.findByRole('dialog', {name: 'Add existing issues'});
  expect(within(dialog).queryByText(/Add 0/)).toBeNull();
  fireEvent.click(within(dialog).getByRole('option', {name: /Refresh docs/}));
  fireEvent.click(await screen.findByRole('option', {name: 'Add 1 selected issue'}));
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  expect(issueProject(s.data.pool, editing(app).overlay, 30)).toEqual({project: 10, column: 11});
  fireEvent.click(screen.getByRole('button', {name: 'Reopen'}));
  const input = await screen.findByRole('combobox', {name: 'Search existing issues'});
  fireEvent.change(input, {target: {value: 'New docs draft'}});
  expect(await screen.findByText('No issue on this device matches')).toBeTruthy();
  fireEvent.keyDown(input, {key: 'Enter'});
  fireEvent.keyPress(input, {key: 'Enter', charCode: 13});
  expect(create).toHaveBeenCalledWith('New docs draft');
  model.dispose();
});

test('Primer template segments preserve creation scope and the wire template value', async () => {
  const {mount} = fixture();
  vi.mocked(onlineWrite).mockResolvedValue({value: {id: 10}, syncId: undefined, totalCount: undefined});
  mount(<NewBoard scope={{repo_id: 0, owner_id: 1}}/>);
  fireEvent.click(screen.getByRole('button', {name: 'New board'}));
  fireEvent.change(await screen.findByRole('textbox', {name: 'Title'}), {target: {value: 'Triage'}});
  fireEvent.click(screen.getByRole('button', {name: 'Bug triage'}));
  fireEvent.click(screen.getByRole('button', {name: 'Create board'}));
  await waitFor(() => { expect(onlineWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({method: 'POST', body: {repo_id: 0, owner_id: 1, title: 'Triage', description: '', card_type: 'text_only', template_type: 'bug_triage'}})); });
});

test('board deletion still requires the exact title and exposes offline reasons', async () => {
  const {mount, project} = fixture();
  vi.mocked(onlineWrite).mockResolvedValue({value: undefined, syncId: undefined, totalCount: undefined});
  mount(<BoardSettings project={project.data}/>);
  fireEvent.click(screen.getByRole('button', {name: 'Board settings'}));
  fireEvent.click(await screen.findByRole('menuitem', {name: 'Delete board…'}));
  const dialog = await screen.findByRole('dialog', {name: 'Delete board?'});
  const remove = within(dialog).getByRole<HTMLButtonElement>('button', {name: 'Delete board'});
  expect(remove.disabled).toBe(true);
  fireEvent.keyDown(within(dialog).getByRole('textbox'), {key: 'Enter'});
  expect(onlineWrite).not.toHaveBeenCalled();
  fireEvent.change(within(dialog).getByRole('textbox'), {target: {value: 'Planning'}});
  expect(remove.disabled).toBe(false);
  runInAction(() => { connectivity.online = false; });
  await waitFor(() => { expect(remove.disabled).toBe(true); });
  expect(screen.getByText(/Deleting a board.*not queued offline/)).toBeTruthy();
  runInAction(() => { connectivity.online = true; });
  await waitFor(() => { expect(remove.disabled).toBe(false); });
  fireEvent.keyDown(within(dialog).getByRole('textbox'), {key: 'Enter'});
  await waitFor(() => { expect(onlineWrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({method: 'DELETE', path: '/projects/10'})); });
});

test('card ActionMenu opens at the pointer or with Shift+F10, returns focus, and moves offline through its submenu', async () => {
  const {mount, app, s} = fixture();
  s.data.put('ProjectIssue', 'repo:20', {id: 40, issue_id: 30, project_id: 10, column_id: 11, sorting: 0});
  s.data.put('ProjectColumn', 'profile:1', {id: 12, title: 'Doing', project_id: 10, default: false, sorting: 1, color: '', creator_id: 1, created_at: T, updated_at: T});
  const submit = vi.spyOn(editing(app).intents, 'submit');
  mount(<BoardPage/>);
  const backlog = await screen.findByRole('listbox', {name: 'Backlog'});
  await waitFor(() => { expect(document.activeElement).toBe(backlog); });
  fireEvent.keyDown(backlog, {key: 'F10', shiftKey: true});
  const keyboardMenu = await screen.findByRole('menu');
  expect(within(keyboardMenu).getByText('Open', {exact: true})).toBeTruthy();
  fireEvent.keyDown(keyboardMenu, {key: 'Escape'});
  await waitFor(() => { expect(document.activeElement).toBe(backlog); });
  expect(fireEvent.contextMenu(backlog, {clientX: 120, clientY: 160})).toBe(false);
  const pointerMenu = await screen.findByRole('menu');
  runInAction(() => { connectivity.online = false; });
  fireEvent.click(within(pointerMenu).getByText('Move to', {exact: true}));
  fireEvent.click(await screen.findByRole('menuitem', {name: 'Doing'}));
  await waitFor(() => { expect(submit).toHaveBeenCalledWith(expect.objectContaining({kind: 'board.move', columnId: 12, issueId: 30})); });
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
  expect(document.activeElement).toBe(backlog);
});
