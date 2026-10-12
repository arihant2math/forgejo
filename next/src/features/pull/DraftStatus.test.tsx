// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {render, screen, within} from '@testing-library/react';
import type {ReactNode} from 'react';
import {expect, test, vi} from 'vitest';
import {AppContext, createApp} from '../../app/store.ts';
import type {NextConfig, PullRequest} from '../../protocol/types.gen.ts';
import {fakeSession, issue, repo, T, user} from '../../test/fakeSession.ts';
import {IssueSidebar} from '../issue/Sidebar.tsx';
import {PullStateCell} from '../issues/cells.tsx';
import {isDraftPull} from './draft.ts';
import {editing} from '../../intents/session.ts';
import {Byline} from '../issue/IssueView.tsx';

vi.mock('@tanstack/react-router', async (original) => ({
  ...await original<object>(),
  useParams: () => ({}),
  Link: ({children}: {children: ReactNode}) => <a href="#link">{children}</a>,
}));

const config: NextConfig = {app_url: 'http://localhost/', app_sub_url: '', base: '/-/next/', app_name: 'Forgejo', version: '', protocol: 1, oauth: null};

function setup(title: string, pr: Partial<PullRequest> = {}) {
  const s = fakeSession();
  const acme = user(2, 'acme', 'organization');
  s.data.put('User', 'profile:1', user(1, 'alice'));
  s.data.put('User', 'org:2', acme);
  s.data.put('User', 'user:5', user(5, 'frank'));
  s.data.put('Repository', 'repo:20', repo(20, acme, 'website'));
  s.data.put('Issue', 'repo:20', issue(100, 20, 7, title, {is_pull: true}));
  s.data.put('PullRequest', 'repo:20', {
    id: 50, issue_id: 100, number: 7, status: 'mergeable', head_repo_id: 20, base_repo_id: 20, head_branch: 'feat', base_branch: 'main', merge_base: '',
    allow_maintainer_edit: false, merged: false, merge_commit_sha: '', merger_id: 0, commits_ahead: 1, commits_behind: 0, conflicted_files: [], flow: 0, ...pr,
  });
  const app = createApp(config, s);
  const entity = s.data.pool.model('Issue').get(100);
  if (!entity) throw new Error('no issue');
  return {s, app, entity, wrap: (node: ReactNode) => render(<AppContext.Provider value={app}>{node}</AppContext.Provider>)};
}

test('a draft pull request\'s Status says Draft, and its header marks carry the Draft badge', () => {
  const {entity, wrap} = setup('WIP: Add the footer');
  wrap(<><IssueSidebar issue={entity}/><h1><PullStateCell issue={entity}/></h1></>);
  const status = screen.getByRole('heading', {name: 'Status'}).closest('section');
  expect(status?.textContent).toContain('Draft');
  expect(status?.textContent).not.toContain('Open');
  expect(within(screen.getByRole('heading', {level: 1})).getByText('Draft')).toBeTruthy();
});

test('a ready pull request stays Open', () => {
  const {entity, wrap} = setup('Add the footer');
  wrap(<IssueSidebar issue={entity}/>);
  expect(screen.getByRole('heading', {name: 'Status'}).closest('section')?.textContent).toContain('Open');
});

test('the byline names the branches, and a fork\'s head its owner', () => {
  const {s, entity, wrap} = setup('Add the footer', {head_repo_id: 21, head_branch: 'docs/leaflet', commits_ahead: 2});
  s.data.put('Repository', 'repo:21', repo(21, user(5, 'frank'), 'website', {fork: true, parent_id: 20, created_at: T}));
  wrap(<Byline issue={entity}/>);
  expect(screen.getByText(/wants to merge 2 commits into/)).toBeTruthy();
  expect(screen.getByText('main')).toBeTruthy();
  expect(screen.getByText('frank:docs/leaflet')).toBeTruthy();
  expect(screen.getByText('Fork')).toBeTruthy();
  expect(screen.getByRole('button', {name: 'Copy head branch name'})).toBeTruthy();
});

test('the byline\'s state label says Draft for a draft, and an issue closed with a canceled status reads as not planned', () => {
  const {s, entity, wrap} = setup('WIP: Add the footer');
  const {unmount} = wrap(<Byline issue={entity}/>);
  expect(screen.getByText('Draft').closest('[data-status]')?.getAttribute('data-status')).toBe('draft');
  unmount();
  s.data.put('Issue', 'repo:20', issue(101, 20, 8, 'Not doing this', {state: 'closed'}));
  s.data.put('Label', 'repo:20', {id: 2, repo_id: 20, org_id: 0, name: 'status/Canceled', exclusive: true, description: '', color: '888888', num_issues: 0, num_closed_issues: 0, created_at: T});
  s.data.put('IssueLabel', 'repo:20', {id: 1, issue_id: 101, label_id: 2});
  const closed = s.data.pool.model('Issue').get(101);
  if (!closed) throw new Error('no issue');
  wrap(<Byline issue={closed}/>);
  expect(screen.getByText('Closed').closest('[data-status]')?.getAttribute('data-status')).toBe('issueClosedNotPlanned');
});

test('draft detection reads optimistic titles and ignores ordinary issues', () => {
  const {app, entity, s} = setup('Add the footer');
  const {overlay, intents} = editing(app);
  expect(isDraftPull(app, overlay, entity)).toBe(false);
  intents.submit({kind: 'issue.title', issueId: entity.id, repoId: 20, title: 'WIP: Add the footer', base: 'Add the footer'});
  expect(isDraftPull(app, overlay, entity)).toBe(true);
  s.data.put('Issue', 'repo:20', issue(101, 20, 8, 'WIP: Ordinary issue'));
  expect(isDraftPull(app, overlay, s.data.pool.model('Issue').get(101)!)).toBe(false);
});
