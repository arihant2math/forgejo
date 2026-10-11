// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createMemoryHistory} from '@tanstack/react-router';
import {act, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {App} from '../../app/App.tsx';
import {createAppRouter} from '../../app/router.tsx';
import {createApp, type Session} from '../../app/store.ts';
import type {Label, Milestone, NextConfig} from '../../protocol/types.gen.ts';
import {fakeSession, issue, repo, user} from '../../test/fakeSession.ts';

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

const milestone = (id: number, title: string, extra: Partial<Milestone> = {}): Milestone => ({
  id, repo_id: 20, title, description: '', state: 'open', open_issues: 0, closed_issues: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra,
});

/** alice reads acme/website (no write access): its labels, the organization's, two milestones. */
function session() {
  const me = user(1, 'alice');
  const acme = user(2, 'acme', 'organization');
  const s = fakeSession({
    workspace: {
      viewer_id: 1, truncated: false, max_repos: 200,
      groups: [{group: 'user:1', units: [], reason: 'self'}, {group: 'org:2', units: [], reason: 'member'}, {group: 'repo:20', units: [], reason: 'member'}],
    },
  });
  s.data.put('User', 'profile:1', me);
  s.data.put('User', 'org:2', acme);
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  s.data.put('Issue', 'repo:20', issue(100, 20, 7, 'Footer links are broken'));
  s.data.put('Issue', 'repo:20', issue(102, 20, 8, 'Docs are stale', {milestone_id: 5}));
  s.data.put('Issue', 'repo:20', issue(103, 20, 9, 'Old crash', {state: 'closed', milestone_id: 5}));
  s.data.put('Label', 'repo:20', label(1, 'bug', {description: 'Something is broken'}));
  s.data.put('Label', 'repo:20', label(2, 'kind/docs', {exclusive: true, color: '#fef2c0'}));
  s.data.put('Label', 'owner:2', label(3, 'security', {repo_id: 0, org_id: 2}));
  s.data.put('IssueLabel', 'repo:20', {id: 1, issue_id: 100, label_id: 1});
  s.data.put('IssueLabel', 'repo:20', {id: 2, issue_id: 102, label_id: 1});
  s.data.put('IssueLabel', 'repo:20', {id: 3, issue_id: 103, label_id: 1});
  s.data.put('Milestone', 'repo:20', milestone(5, 'v1.0', {due_on: '2020-01-31T23:59:59Z', open_issues: 1, closed_issues: 1, description: 'The **first** release'}));
  s.data.put('Milestone', 'repo:20', milestone(6, 'v0.9', {state: 'closed', closed_issues: 3, closed_at: '2019-12-01T00:00:00Z'}));
  return s;
}

describe('labels and milestones', () => {
  test('the issue list links its labels and milestones, with their counts', async () => {
    await renderApp('/acme/website/issues', session());
    const labels = screen.getByRole('link', {name: /^Labels/});
    expect(labels.getAttribute('href')).toBe('/acme/website/labels');
    expect(labels.textContent).toBe('Labels3');
    expect(screen.getByRole('link', {name: /^Milestones/}).textContent).toBe('Milestones1');
  });

  test('labels: pills, descriptions, open counts linking to the filtered list, the organization\'s apart; search', async () => {
    const s = session();
    const {router} = await renderApp('/acme/website/labels', s);
    expect(screen.getByRole('heading', {level: 1}).textContent).toBe('Labels');
    expect(within(screen.getByRole('navigation', {name: 'Repository'})).getByRole('link', {name: /^Issues/}).getAttribute('aria-current')).toBe('page');
    const own = screen.getByRole('region', {name: 'Labels'});
    expect(within(own).getByText('Something is broken')).toBeTruthy();
    // Two open issues have "bug" (the closed one does not count).
    expect(within(own).getByRole('link', {name: '2 open issues'}).getAttribute('href')).toBe('/acme/website/issues?labels=1');
    expect(within(own).getByRole('link', {name: 'No open issues'}).getAttribute('href')).toBe('/acme/website/issues?labels=2');
    // An exclusive scoped label shows its scope.
    expect(within(own).getByText('kind/docs')).toBeTruthy();
    expect(within(screen.getByRole('region', {name: 'Labels of acme'})).getByText('security')).toBeTruthy();
    // A reader gets no write controls.
    expect(screen.queryByRole('button', {name: 'New label'})).toBeNull();
    // A delta (a pull request gets "kind/docs") moves the counts.
    s.data.put('Issue', 'repo:20', issue(104, 20, 10, 'Docs PR', {is_pull: true}));
    s.data.put('IssueLabel', 'repo:20', {id: 4, issue_id: 104, label_id: 2});
    expect(await within(own).findByRole('link', {name: '1 pull request'})).toBeTruthy();
    expect(within(own).getByRole('link', {name: '1 pull request'}).getAttribute('href')).toBe('/acme/website/pulls?labels=2');
    await act(() => router.navigate({to: '/$owner/$repo/labels', params: {owner: 'acme', repo: 'website'}, search: {q: 'broken'}}));
    expect(within(screen.getByRole('region', {name: 'Labels'})).queryByText('kind/docs')).toBeNull();
    expect(within(screen.getByRole('region', {name: 'Labels'})).getByText('Something is broken')).toBeTruthy();
  });

  test('organization labels on a repository\'s page: who manages them, their open counts and links, their own colours', async () => {
    const s = session();
    s.auth.token = () => Promise.resolve('token');
    // alice is a member of acme, neither owner nor admin; API v1 gives colours without their "#".
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), {status: 200, headers: {'Content-Type': 'application/json'}}));
      if (url.includes('/api/v1/users/alice/orgs/acme/permissions')) return json({is_owner: false, is_admin: false});
      if (url.includes('/api/v1/orgs/acme/labels')) {
        return json([{id: 3, name: 'security', exclusive: false, is_archived: false, color: 'ffffff', description: ''}, {id: 4, name: 'priority/Urgent', exclusive: true, is_archived: false, color: 'e11d21', description: 'Drop everything'}]);
      }
      return json([]);
    }));
    s.data.put('IssueLabel', 'repo:20', {id: 5, issue_id: 100, label_id: 3});
    await renderApp('/acme/website/labels', s);
    const org = screen.getByRole('region', {name: 'Labels of acme'});
    expect(await within(org).findByText(/Managed by the owners and admins of acme/)).toBeTruthy();
    expect(within(org).queryByRole('button', {name: /Edit organization label/})).toBeNull();
    // Counted in this repository, linked to its lists filtered by the label, like the repository's own.
    await waitFor(() => {
      expect(within(org).getByRole('link', {name: '1 open issue'}).getAttribute('href')).toBe('/acme/website/issues?labels=3');
    });
    expect(within(org).getByRole('link', {name: 'No open issues'}).getAttribute('href')).toBe('/acme/website/issues?labels=4');
    // Their own colours (a filled pill, not the grey fallback chip), the scope shown.
    const urgent = within(org).getByText('priority/Urgent').closest<HTMLElement>('[data-size]');
    expect(urgent?.style.getPropertyValue('--label-r')).toBe('225');
    expect(urgent?.style.getPropertyValue('--label-g')).toBe('29');
    expect(urgent?.style.getPropertyValue('--label-b')).toBe('33');
    vi.unstubAllGlobals();
  });

  test('milestones: open and closed tabs, overdue, progress, counts to the milestone\'s page', async () => {
    const {router} = await renderApp('/acme/website/milestones', session());
    const panel = screen.getByRole('region', {name: 'Milestones'});
    expect(within(panel).getByRole('link', {name: 'v1.0'}).getAttribute('href')).toBe('/acme/website/milestone/5');
    expect(within(panel).getByText('Overdue')).toBeTruthy();
    expect(within(panel).getByText('50% complete')).toBeTruthy();
    expect(within(panel).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    expect(within(panel).getByRole('link', {name: '1 closed'}).getAttribute('href')).toBe('/acme/website/milestone/5?state=closed');
    expect(within(panel).queryByText('v0.9')).toBeNull();
    fireEvent.click(within(panel).getByRole('button', {name: /Closed/}));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({state: 'closed'});
    });
    expect(within(screen.getByRole('region', {name: 'Milestones'})).getByRole('link', {name: 'v0.9'})).toBeTruthy();
  });

  test('a milestone\'s page lists its issues and pull requests', async () => {
    await renderApp('/acme/website/milestone/5', session());
    expect(screen.getByRole('heading', {level: 1}).textContent).toBe('v1.0');
    const list = await screen.findByRole('listbox', {name: 'Issues and pull requests of v1.0'});
    expect(within(list).getByText('Docs are stale')).toBeTruthy();
    expect(within(list).queryByText('Footer links are broken')).toBeNull();
    expect(screen.getByText('1 open · 1 closed')).toBeTruthy();
  });

  test('a writer\'s new label shows at once and stays once synced; a refused deletion comes back with a notice', async () => {
    const s = session();
    s.data.put('Access', 'user:1', {id: 1, user_id: 1, repo_id: 20, permission: 'write'});
    s.auth.token = () => Promise.resolve('token');
    const sent: {method: string; url: string; body: unknown}[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      sent.push({method, url, body: init?.body ? JSON.parse(init.body as string) as unknown : undefined});
      const json = (v: unknown, status: number, headers: Record<string, string> = {}) => Promise.resolve(new Response(JSON.stringify(v), {status, headers: {'Content-Type': 'application/json', ...headers}}));
      if (method === 'POST' && url.endsWith('/api/v1/repos/acme/website/labels')) return json({id: 50}, 201, {'X-Livesync-Sync-Id': '9'});
      if (method === 'DELETE') return json({message: 'The label is in use.'}, 422);
      return json({message: 'not here'}, 404);
    }));
    // The pool holds the new label once synced (the echoed sync id).
    s.data.whenSynced = () => {
      s.data.put('Label', 'repo:20', label(50, 'triage', {color: '#fbca04'}));
      return Promise.resolve();
    };
    const {app} = await renderApp('/acme/website/labels', s);
    fireEvent.click(screen.getByRole('button', {name: 'New label'}));
    const dialog = await screen.findByRole('dialog', {name: 'New label'});
    fireEvent.change(within(dialog).getByRole('textbox', {name: 'Name'}), {target: {value: 'triage'}});
    fireEvent.change(within(dialog).getByRole('textbox', {name: 'Colour'}), {target: {value: 'fbca04'}});
    fireEvent.click(within(dialog).getByRole('button', {name: 'Create label'}));
    expect(within(screen.getByRole('region', {name: 'Labels'})).getByText('triage')).toBeTruthy();
    await waitFor(() => {
      expect(sent.find((r) => r.method === 'POST')?.body).toEqual({name: 'triage', color: '#fbca04', description: '', exclusive: false, is_archived: false});
    });
    // Forgejo's label (id 50) in place of the optimistic one, never both.
    await waitFor(() => {
      expect(within(screen.getByRole('region', {name: 'Labels'})).getAllByRole('link').some((a) => a.getAttribute('href') === '/acme/website/issues?labels=50')).toBe(true);
    });
    expect(within(screen.getByRole('region', {name: 'Labels'})).getAllByText('triage')).toHaveLength(1);
    // Deleting: gone at once, back when Forgejo refuses, with why.
    fireEvent.click(screen.getByRole('button', {name: 'Delete bug'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Delete label'}));
    expect(within(screen.getByRole('region', {name: 'Labels'})).queryByText('Something is broken')).toBeNull();
    await waitFor(() => {
      expect(within(screen.getByRole('region', {name: 'Labels'})).getByText('Something is broken')).toBeTruthy();
    });
    expect(app.ui.notices.map((n) => [n.title, n.description])).toContainEqual(['Deleting the label “bug” failed', 'The label is in use.']);
    vi.unstubAllGlobals();
  });

  test('a milestone\'s bad due date is shown on the due date field, not on the title', async () => {
    const s = session();
    s.data.put('Access', 'user:1', {id: 1, user_id: 1, repo_id: 20, permission: 'write'});
    s.auth.token = () => Promise.resolve('token');
    const fetch = vi.fn((_url: string) => Promise.resolve(new Response('{}', {status: 404, headers: {'Content-Type': 'application/json'}})));
    vi.stubGlobal('fetch', fetch);
    await renderApp('/acme/website/milestones/new', s);
    const title = await screen.findByRole('textbox', {name: 'Title'});
    fireEvent.change(title, {target: {value: 'zz-verify-date'}});
    const due = screen.getByLabelText('Due date');
    expect(due.getAttribute('max')).toBe('9999-12-31');
    // What Chromium's date field holds after "2026-11-02" is typed into its mm/dd/yyyy segments.
    fireEvent.change(due, {target: {value: '61102-02-02'}});
    fireEvent.click(screen.getByRole('button', {name: 'Create milestone'}));
    expect(due.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(due.getAttribute('aria-describedby') ?? '')?.textContent).toBe('The year needs four digits.');
    expect(document.activeElement).toBe(due);
    expect(title.getAttribute('aria-invalid')).not.toBe('true');
    expect(screen.queryByText('A milestone needs a title.')).toBeNull();
    expect(fetch.mock.calls.some(([url]) => url.includes('/milestones'))).toBe(false);
    vi.unstubAllGlobals();
  });

  test('an issue\'s page links a reader to its labels and its milestone', async () => {
    await renderApp('/acme/website/issues/8', session());
    const m = await screen.findByText('v1.0');
    expect(m.closest('a')?.getAttribute('href')).toBe('/acme/website/milestone/5');
    expect(screen.getAllByText('bug').some((el) => el.closest('a')?.getAttribute('href') === '/acme/website/issues?labels=1')).toBe(true);
  });
});
