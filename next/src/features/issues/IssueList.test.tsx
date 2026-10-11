// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The repository issue list as a user sees it (QA findings #158, #189, #191, #192, #205, #215, #217).

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

/**
 * alice writes to acme/website. #7 (by bob) is assigned to alice and carol; #8 (by alice) to nobody; #9 (by bob) to
 * carol and has status/Todo. The organization's labels are its statuses and priorities.
 */
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
    // The accessible name reads "… by bob"; the login is named in full on hover.
    expect(r.getAttribute('aria-label') ?? r.textContent).toMatch(/by bob/);
    const author = within(r).getByTitle('Opened by Bob Okafor (bob)');
    expect(author.textContent).toBe('by bob');
    expect(within(row(/Docs are stale/)).getByTitle('Opened by Alice Nakamura (alice)')).toBeTruthy();
    // Every assignee avatar is named on hover, like the status and priority icons.
    expect(within(r).getByTitle('Assignee: Alice Nakamura (alice)')).toBeTruthy();
    expect(within(r).getByTitle('Assignee: carol')).toBeTruthy();
  });

  test('grouped by assignee, a shared issue is listed under each of its assignees (#189)', async () => {
    await renderApp('/acme/website/issues?group=assignee', session());
    const list = await screen.findByRole('listbox');
    await waitFor(() => {
      expect(within(list).getAllByRole('option', {name: /Footer links are broken/})).toHaveLength(2);
    });
    // Headers: Alice Nakamura 1, carol 2 (#7 and #9), Unassigned 1.
    expect(within(list).getByText('Alice Nakamura').nextElementSibling?.textContent).toBe('1');
    expect(within(list).getByText('carol').nextElementSibling?.textContent).toBe('2');
    expect(within(list).getByText('Unassigned').nextElementSibling?.textContent).toBe('1');
    // The rows' DOM ids stay unique (the cursor's aria-activedescendant points at one).
    const ids = within(list).getAllByRole('option').map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The list still counts three issues, each once.
    expect(within(list).getAllByRole('option')).toHaveLength(4);
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
    // Nothing is selected: no selection bar, and the check boxes wait for the pointer (hidden from screen readers:
    // the row's aria-selected says it, X selects).
    expect(screen.queryByRole('button', {name: /Edit selected/})).toBeNull();
    const box = checkBox(r);
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.parentElement?.className).toContain('group-hover:visible');
    fireEvent.click(box);
    expect(router.state.location.pathname).toBe('/acme/website/issues');
    await waitFor(() => {
      expect(row(/Footer links are broken/).getAttribute('aria-selected')).toBe('true');
    });
    // Selecting: every row shows its box.
    expect(screen.getByRole('listbox').hasAttribute('data-selecting')).toBe(true);
    expect(screen.getByText(/1 selected/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Select all 3'}));
    await waitFor(() => {
      expect(screen.getAllByRole('option').every((o) => o.getAttribute('aria-selected') === 'true')).toBe(true);
    });
    expect(screen.queryByRole('button', {name: /Select all/})).toBeNull();
    // The selection's actions: the milestone picker for the three issues.
    const edit = screen.getByRole('button', {name: /Edit selected/});
    fireEvent.click(edit);
    fireEvent.click(await screen.findByRole('menuitem', {name: /Set milestone/}));
    expect(app.ui.picker?.kind).toBe('milestone');
    expect([...(app.ui.picker?.issueIds ?? [])].sort()).toEqual([100, 102, 103]);
    act(() => {
      app.ui.picker = undefined;
    });
    fireEvent.click(screen.getByRole('button', {name: 'Clear the selection'}));
    await waitFor(() => {
      expect(screen.getAllByRole('option').some((o) => o.getAttribute('aria-selected') === 'true')).toBe(false);
    });
    expect(screen.getByRole('listbox').hasAttribute('data-selecting')).toBe(false);
  });

  test('Shift on a check box selects the range from the cursor', async () => {
    await renderApp('/acme/website/issues', session());
    const first = await screen.findByRole('option', {name: /Footer links are broken/});
    fireEvent.click(checkBox(first));
    fireEvent.click(checkBox(row(/Dark mode/)), {shiftKey: true});
    await waitFor(() => {
      expect(screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(3);
    });
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

describe('the issue\'s status (#192)', () => {
  test('an open issue without a status label reads "Open · No status" where the repository has statuses', async () => {
    await renderApp('/acme/website/issues/8', session());
    const status = await screen.findByRole('button', {name: /^Status/});
    expect(status.textContent).toContain('Open');
    expect(status.textContent).toContain('· No status');
    await act(() => Promise.resolve());
  });

  test('with a status label the status reads it', async () => {
    await renderApp('/acme/website/issues/9', session());
    const status = await screen.findByRole('button', {name: /^Status/});
    expect(status.textContent).toContain('Todo');
    expect(status.textContent).not.toContain('No status');
  });
});

describe('the Labels picker\'s selection semantics (#179)', () => {
  test('the applied labels are the selected options; the highlighted one is not', async () => {
    const s = session();
    s.data.put('Label', 'repo:20', label(2, 'docs'));
    s.data.put('IssueLabel', 'repo:20', {id: 2, issue_id: 103, label_id: 2});
    await renderApp('/acme/website/issues/9', s);
    fireEvent.click(await screen.findByRole('button', {name: /^Labels/}));
    const list = await screen.findByRole('listbox', {name: 'Change labels'});
    expect(list.getAttribute('aria-multiselectable')).toBe('true');
    const bug = within(list).getByRole('option', {name: 'bug'});
    // Primer separates keyboard focus from applied values; focusing an option never applies it.
    bug.focus();
    expect(document.activeElement).toBe(bug);
    expect(screen.getByRole('combobox', {name: 'Change labels'})).toBeTruthy();
    expect(bug.getAttribute('aria-selected')).toBe('false');
    expect(within(list).getAllByRole('option', {selected: true}).map((o) => o.textContent)).toEqual(['docs']);
    // Applying "bug" makes it selected.
    fireEvent.click(bug);
    await waitFor(() => {
      expect(within(list).getAllByRole('option', {selected: true}).map((o) => o.textContent)).toEqual(['bug', 'docs']);
    });
  });
});

describe('the Labels picker and status/priority labels (#215)', () => {
  test('a search that names a status or priority label finds it under its field, which sets it', () => {
    const s = session();
    const app = createApp(config, s);
    const labels = (query: string) => pickerOptions(app, 'labels', [102], query).options;
    // Opened: the plain labels only (the fields have their pickers, S and P).
    expect(labels('').map((o) => o.label)).toEqual(['bug']);
    // Searched: the Labels page's names find them, grouped under their field.
    const found = labels('status/todo');
    expect(found.map((o) => [o.group, o.label])).toContainEqual(['Status field (S)', 'status/Todo']);
    expect(labels('prio').map((o) => [o.group, o.label])).toContainEqual(['Priority field (P)', 'priority/High']);
    // Choosing one sets the field (a status replaces the issue's other status).
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
