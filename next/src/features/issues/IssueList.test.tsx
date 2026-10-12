// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp, type Session} from '../../app/store.ts';
import {editing} from '../../intents/session.ts';
import {issueLabelIds} from '../../intents/view.ts';
import type {Label, NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';
import {pickerOptions, type PickerDraft} from './Picker.tsx';

afterEach(() => {
  localStorage.clear();
});

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

async function renderApp(path: string, session: Session) {
  const app = createApp(config, session);
  const router = createAppRouter(app, createMemoryHistory({initialEntries: [path]}));
  await router.load();
  render(<App app={app} router={router}/>);
  return {app, router};
}

const label = (id: number, name: string, extra: Partial<Label> = {}): Label => ({
  id, repo_id: 20, org_id: 0, name, exclusive: false, description: '', color: '#e11d21', num_issues: 0, num_closed_issues: 0, created_at: '2026-01-01T00:00:00Z', ...extra,
});

function session() {
  const alice = {...user(1, 'alice'), full_name: 'Alice Nakamura'};
  const acme = user(2, 'acme', 'organization');
  const s = fakeSession({
    userId: 1,
    workspace: {
      viewer_id: 1, truncated: false, max_repos: 200,
      groups: [{group: 'user:1', units: [], reason: 'self'}, {group: 'org:2', units: [], reason: 'member'}, {group: 'repo:20', units: [], reason: 'member'}],
    },
  });
  s.data.put('User', 'profile:1', alice);
  s.data.put('User', 'org:2', acme);
  s.data.put('User', 'profiles:public', {...user(3, 'bob'), full_name: 'Bob Okafor'});
  s.data.put('User', 'profiles:public', user(4, 'carol'));
  s.data.put('Access', 'user:1', {id: 1, user_id: 1, repo_id: 20, permission: 'write'});
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  s.data.put('Issue', 'repo:20', issue(100, 20, 7, 'Footer links are broken', {poster_id: 3, created_at: '2026-01-03T00:00:00Z'}));
  s.data.put('Issue', 'repo:20', issue(102, 20, 8, 'Docs are stale', {poster_id: 1, created_at: '2026-01-02T00:00:00Z'}));
  s.data.put('Issue', 'repo:20', issue(103, 20, 9, 'Dark mode', {poster_id: 3, created_at: '2026-01-01T00:00:00Z'}));
  s.data.put('IssueAssignee', 'repo:20', {id: 1, issue_id: 100, assignee_id: 1});
  s.data.put('IssueAssignee', 'repo:20', {id: 2, issue_id: 100, assignee_id: 4});
  s.data.put('IssueAssignee', 'repo:20', {id: 3, issue_id: 103, assignee_id: 4});
  s.data.put('Label', 'repo:20', label(1, 'bug'));
  s.data.put('Label', 'owner:2', label(11, 'status/Backlog', {repo_id: 0, org_id: 2, exclusive: true}));
  s.data.put('Label', 'owner:2', label(12, 'status/Todo', {repo_id: 0, org_id: 2, exclusive: true}));
  s.data.put('Label', 'owner:2', label(13, 'status/Done', {repo_id: 0, org_id: 2, exclusive: true}));
  s.data.put('Label', 'owner:2', label(21, 'priority/High', {repo_id: 0, org_id: 2, exclusive: true}));
  s.data.put('IssueLabel', 'repo:20', {id: 1, issue_id: 103, label_id: 12});
  return s;
}

const row = (title: RegExp) => screen.getByRole('option', {name: title});

function checkBox(r: HTMLElement): HTMLInputElement {
  const box = r.querySelector<HTMLInputElement>('input[type=checkbox]');
  if (!box) throw new Error('no check box in the row');
  return box;
}

describe('issue list rows', () => {
  test('each row names its author (#217) and its assignees on hover (#191)', async () => {
    await renderApp('/acme/website/issues', session());
    const r = await screen.findByRole('option', {name: /Footer links are broken/});
    expect(r.getAttribute('aria-label') ?? r.textContent).toMatch(/by bob/);
    const author = within(r).getByTitle('Opened by Bob Okafor (bob)');
    expect(author.textContent).toBe('by bob');
    expect(within(row(/Docs are stale/)).getByTitle('Opened by Alice Nakamura (alice)')).toBeTruthy();
    expect(within(r).getByTitle('Assignee: Alice Nakamura (alice)')).toBeTruthy();
    expect(within(r).getByTitle('Assignee: carol')).toBeTruthy();
  });

  test('grouped by assignee, a shared issue is listed under each of its assignees (#189)', async () => {
    await renderApp('/acme/website/issues?group=assignee', session());
    const list = await screen.findByRole('listbox');
    await waitFor(() => {
      expect(within(list).getAllByRole('option', {name: /Footer links are broken/})).toHaveLength(2);
    });
    const alice = within(list).getByText('Alice Nakamura');
    expect(alice.textContent).toBe('Alice Nakamuraalice');
    expect(within(alice).getByText('alice').className).toContain('text-muted');
    expect(alice.nextElementSibling?.textContent).toBe('1');
    expect(within(list).getByText('carol').nextElementSibling?.textContent).toBe('2');
    expect(within(list).getByText('Unassigned').nextElementSibling?.textContent).toBe('1');
    // Multi-assignee rows need unique ids for aria-activedescendant.
    const ids = within(list).getAllByRole('option').map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(within(list).getAllByRole('option')).toHaveLength(4);
  });

  test('grouped by assignee, two people of the same name get headers told apart by their logins (#263)', async () => {
    const s = session();
    s.data.put('User', 'profiles:public', {...user(5, 'u-m14-next'), full_name: 'Alice Nakamura'});
    s.data.put('IssueAssignee', 'repo:20', {id: 4, issue_id: 102, assignee_id: 5});
    await renderApp('/acme/website/issues?group=assignee', s);
    const list = await screen.findByRole('listbox');
    await waitFor(() => {
      expect(within(list).getAllByText('Alice Nakamura')).toHaveLength(2);
    });
    const headers = within(list).getAllByText('Alice Nakamura').map((h) => [h.textContent, h.nextElementSibling?.textContent]);
    expect(headers).toEqual([['Alice Nakamuraalice', '1'], ['Alice Nakamurau-m14-next', '1']]);
  });

  test('grouped by status, an open issue without a status label is under "No status", not "Open" (#192)', async () => {
    await renderApp('/acme/website/issues?group=status', session());
    const list = await screen.findByRole('listbox');
    await waitFor(() => {
      expect(within(list).getByText('No status').nextElementSibling?.textContent).toBe('2');
    });
    expect(within(list).queryByText('Open')).toBeNull();
    expect(within(list).getByText('Todo').nextElementSibling?.textContent).toBe('1');
  });
});

describe('selection for the pointer (#205)', () => {
  test('a row\'s check box selects it without opening it; the bar selects all and edits the selection', async () => {
    const {app, router} = await renderApp('/acme/website/issues', session());
    const r = await screen.findByRole('option', {name: /Footer links are broken/});
    expect(screen.queryByRole('button', {name: /Edit selected/})).toBeNull();
    const box = checkBox(r);
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.parentElement?.className).toContain('group-hover:visible');
    fireEvent.click(box);
    expect(router.state.location.pathname).toBe('/acme/website/issues');
    await waitFor(() => {
      expect(row(/Footer links are broken/).getAttribute('aria-selected')).toBe('true');
    });
    expect(screen.getByRole('listbox').hasAttribute('data-selecting')).toBe(true);
    expect(screen.getByText(/1 selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Select all 3'}));
    await waitFor(() => {
      expect(screen.getAllByRole('option').every((o) => o.getAttribute('aria-selected') === 'true')).toBe(true);
    });
    expect(screen.queryByRole('button', {name: /Select all/})).toBeNull();
    const edit = screen.getByRole('button', {name: /Edit selected/});
    fireEvent.click(edit);
    fireEvent.click(await screen.findByRole('menuitem', {name: /Set milestone/}));
    expect(app.ui.picker?.kind).toBe('milestone');
    expect([...(app.ui.picker?.issueIds ?? [])].sort()).toEqual([100, 102, 103]);
    fireEvent.click(await screen.findByRole('button', {name: 'Cancel'}));
    fireEvent.click(await screen.findByRole('button', {name: /^Clear the selection\b/}));
    await waitFor(() => {
      expect(screen.getAllByRole('option').some((o) => o.getAttribute('aria-selected') === 'true')).toBe(false);
    });
    expect(screen.getByRole('listbox').hasAttribute('data-selecting')).toBe(false);
  });

  test('Shift on a check box selects the range from the last checked row', async () => {
    await renderApp('/acme/website/issues', session());
    const first = await screen.findByRole('option', {name: /Footer links are broken/});
    fireEvent.click(checkBox(first));
    fireEvent.click(checkBox(row(/Dark mode/)), {shiftKey: true});
    await waitFor(() => {
      expect(screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(3);
    });
  });

  test('Shift on a check box without a selection selects only that row, whatever row the cursor is on', async () => {
    await renderApp('/acme/website/issues', session());
    const list = await screen.findByRole('listbox');
    list.focus();
    fireEvent.keyDown(list, {key: 'ArrowDown'});
    expect(list.getAttribute('aria-activedescendant')).toBe('issue-row-102');
    fireEvent.click(checkBox(row(/Dark mode/)), {shiftKey: true});
    await waitFor(() => {
      expect(row(/Dark mode/).getAttribute('aria-selected')).toBe('true');
    });
    expect(screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);
  });
});

describe('a filter on a deleted label (#158)', () => {
  test('the chip says the label was deleted, and the empty list says why and drops it', async () => {
    const {router} = await renderApp('/acme/website/issues?labels=73', session());
    expect(await screen.findByRole('button', {name: 'Label: (deleted label)'})).toBeTruthy();
    expect(screen.queryByText(/#73/)).toBeNull();
    expect(screen.getByText(/names a label that no longer exists/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Drop the deleted label'}));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(await screen.findByRole('option', {name: /Footer links are broken/})).toBeTruthy();
  });

  test('a label that exists keeps its name; one of several deleted ones is dropped alone', async () => {
    const {router} = await renderApp('/acme/website/issues?labels=1,73', session());
    expect(await screen.findByRole('button', {name: 'Label: bug +1'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Drop the deleted label'}));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({labels: '1'});
    });
  });
});

describe('My lists', () => {
  test('an ungrouped row names its repository with its owner, as other issue references do', async () => {
    await renderApp('/issues?group=none', session());
    const r = await screen.findByRole('option', {name: /Footer links are broken/});
    expect(within(r).getByTitle('acme/website #7')).toBeTruthy();
  });
});

describe('the filter menu', () => {
  test('lists the filters in effect and clears them all, keeping the search and the state', async () => {
    const {router} = await renderApp('/acme/website/issues?poster=3&labels=1&q=docs&state=all', session());
    fireEvent.click(await screen.findByRole('button', {name: 'Label: bug +1'}));
    const list = await screen.findByRole('listbox', {name: 'Filter'});
    expect(within(list).getByRole('option', {name: 'Author: bob'})).toBeTruthy();
    expect(within(list).getByRole('option', {name: 'Nobody'})).toBeTruthy();
    fireEvent.click(within(list).getByRole('option', {name: 'Clear all filters'}));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({q: 'docs', state: 'all'});
    });
  });
});

describe('the empty list', () => {
  test('a page\'s own constraint is not a filter: an empty Assigned list says so, not "Nothing matches"', async () => {
    await renderApp('/pulls?type=assigned', session());
    expect(await screen.findByText('All clear')).toBeTruthy();
    expect(screen.queryByText('Nothing matches')).toBeNull();
    expect(screen.queryByText(/\d+ results?$/)).toBeNull();
  });

  test('a filter from the URL empties the list with "Nothing matches" and a result count', async () => {
    await renderApp('/acme/website/issues?poster=4', session());
    expect(await screen.findByText('Nothing matches')).toBeTruthy();
    expect(screen.getByText('0 results')).toBeTruthy();
  });
});

describe('the issue\'s status (#192)', () => {
  test('an open issue without a status label reads "Open · No status" where the repository has statuses', async () => {
    await renderApp('/acme/website/issues/8', session());
    const heading = await screen.findByRole('heading', {name: 'Status'});
    const status = heading.closest('section');
    if (!status) throw new Error('Missing status field');
    expect(within(status).getByText('Open')).toBeTruthy();
    expect(within(status).getByText('· No status')).toBeTruthy();
    expect(within(status).getByRole('button', {name: /^Change status\b/})).toBeTruthy();
    await act(() => Promise.resolve());
  });

  test('with a status label the status reads it', async () => {
    await renderApp('/acme/website/issues/9', session());
    const heading = await screen.findByRole('heading', {name: 'Status'});
    const status = heading.closest('section');
    if (!status) throw new Error('Missing status field');
    expect(within(status).getByText('Todo')).toBeTruthy();
    expect(within(status).queryByText(/No status/)).toBeNull();
    expect(within(status).getByRole('button', {name: /^Change status\b/})).toBeTruthy();
  });
});

describe('the Labels picker\'s selection semantics (#179)', () => {
  test('the applied labels are the selected options; the highlighted one is not', async () => {
    const s = session();
    s.data.put('Label', 'repo:20', label(2, 'docs'));
    s.data.put('IssueLabel', 'repo:20', {id: 2, issue_id: 103, label_id: 2});
    await renderApp('/acme/website/issues/9', s);
    expect(await screen.findByRole('heading', {name: 'Labels'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: /^Change labels\b/}));
    const list = await screen.findByRole('listbox', {name: 'Change labels'});
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    const bug = within(list).getByRole('option', {name: 'bug'});
    // Primer keeps DOM focus on the combobox; moving its active descendant must not apply a value.
    bug.focus();
    const input = screen.getByRole('combobox', {name: 'Change labels'});
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-activedescendant')).toBe(bug.id);
    expect(within(list).getByRole('option', {name: 'bug', selected: false})).toBe(bug);
    expect(within(list).getByRole('option', {name: 'docs', selected: true})).toBeTruthy();
    expect(within(list).getAllByRole('option', {selected: true})).toHaveLength(1);
    fireEvent.click(bug);
    await waitFor(() => {
      expect(within(list).getByRole('option', {name: 'bug', selected: true})).toBeTruthy();
      expect(within(list).getByRole('option', {name: 'docs', selected: true})).toBeTruthy();
      expect(within(list).getAllByRole('option', {selected: true})).toHaveLength(2);
    });
  });
});

describe('the Labels picker and status/priority labels (#215)', () => {
  test('a search that names a status or priority label finds it under its field, which sets it', () => {
    const s = session();
    const app = createApp(config, s);
    const labels = (query: string) => pickerOptions(app, 'labels', [102], query).options;
    expect(labels('').map((o) => o.label)).toEqual(['bug']);
    const found = labels('status/todo');
    expect(found.map((o) => [o.group, o.label])).toContainEqual(['Status field (S)', 'status/Todo']);
    expect(labels('prio').map((o) => [o.group, o.label])).toContainEqual(['Priority field (P)', 'priority/High']);
    found.find((o) => o.label === 'status/Todo')?.onSelect();
    const {overlay} = editing(app);
    expect(issueLabelIds(s.data.pool, overlay, 102)).toContain(12);
    labels('backlog').find((o) => o.label === 'status/Backlog')?.onSelect();
    expect(issueLabelIds(s.data.pool, overlay, 102)).toContain(11);
    expect(issueLabelIds(s.data.pool, overlay, 102)).not.toContain(12);
  });

  test('a new issue\'s draft gets the label through its own toggle', () => {
    const app = createApp(config, session());
    const draft: PickerDraft = {repoId: 20, labels: [], assignees: [], milestone: 0, toggleLabel: vi.fn(), setAssignee: vi.fn(), setMilestone: vi.fn()};
    pickerOptions(app, 'labels', [], 'high', draft).options.find((o) => o.label === 'priority/High')?.onSelect();
    expect(draft.toggleLabel).toHaveBeenCalledWith(expect.objectContaining({id: 21}), true, expect.any(Array));
  });
});
