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

test('#178: a draft pull request\'s Status says Draft, and its header marks carry the Draft badge', () => {
  const {entity, wrap} = setup('WIP: Add the footer');
  wrap(<><IssueSidebar issue={entity}/><h1><PullStateCell issue={entity}/></h1></>);
  const status = screen.getByText('Status').parentElement;
  expect(status?.textContent).toContain('Draft');
  expect(status?.textContent).not.toContain('Open');
  expect(within(screen.getByRole('heading', {level: 1})).getByText('Draft')).toBeTruthy();
});

test('#178: a ready pull request stays Open', () => {
  const {entity, wrap} = setup('Add the footer');
  wrap(<IssueSidebar issue={entity}/>);
  expect(screen.getByText('Status').parentElement?.textContent).toContain('Open');
});

test('#200: a fork\'s head names its owner', () => {
  const {s, entity, wrap} = setup('Add the footer', {head_repo_id: 21, head_branch: 'docs/leaflet'});
  s.data.put('Repository', 'repo:21', repo(21, user(5, 'frank'), 'website', {fork: true, parent_id: 20, created_at: T}));
  wrap(<IssueSidebar issue={entity}/>);
  expect(screen.getByText('frank:docs/leaflet')).toBeTruthy();
  expect(screen.getByText('Fork')).toBeTruthy();
});
