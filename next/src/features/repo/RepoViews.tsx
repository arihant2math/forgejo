// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Repository list pages (/{owner}/{repo}/issues, /pulls): the repository's
// group is held while one is open; the list is computed from the pool
// (features/issues). One issue or pull request is features/issue
// (its own chunk).

import {getRouteApi, useNavigate} from '@tanstack/react-router';
import {useEffect} from 'react';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import {CircleDot, GitPullRequest, SquarePen} from 'lucide-react';
import {openCreate} from '../../app/create.ts';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {observer} from 'mobx-react-lite';
import {PageBody} from '../../app/shell/Frame.tsx';
import type {ListSearch} from '../../app/search.ts';
import {Button, EmptyState, Icon} from '../../ui/index.ts';
import {preloadEditor} from '../editor/Composer.tsx';
import {CodeLink} from '../code/nav.tsx';
import {loadPeople} from '../issues/people.ts';
import {ListControls} from '../issues/ListBar.tsx';
import {ListBody, useListModel} from '../issues/ListPage.tsx';
import {IssueNav} from '../meta/IssueNav.tsx';
import {RepoHeader, Unavailable, useRepoPage} from './repoPage.tsx';

const issuesApi = getRouteApi('/shell/$owner/$repo/issues');
const pullsApi = getRouteApi('/shell/$owner/$repo/pulls');

/** One repository's list: the page owns the live query, which the header's controls and the list share. */
const RepoListPage = observer(function RepoListPage({owner, repo, repoId, pulls, search}: {owner: string; repo: string; repoId: number; pulls: boolean; search: ListSearch}) {
  const app = useApp();
  const model = useListModel({kind: 'repo', repoId, pulls}, search, 'none');
  const noun = pulls ? 'pull requests' : 'issues';
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={pulls ? GitPullRequest : CircleDot} title={pulls ? 'Pull requests' : 'Issues'}>
        <ListControls model={model} repoId={repoId} hideGroups={['repo']}/>
        {/* GitHub's Labels and Milestones beside the list's controls. */}
        <IssueNav owner={owner} repo={repo} repoId={repoId}/>
        {/* Creating from the list (C as well). A pull request starts from a comparison: its branches are chosen there. */}
        {pulls ?
          <NewPullButton owner={owner} repo={repo} repoId={repoId}/> :
          <Button size="sm" icon={SquarePen} shortcut={shortcutHint('create')} tooltip="New issue" onClick={() => {
            openCreate(app, repoId);
          }}>New issue</Button>}
      </RepoHeader>
      <ListBody model={model} label={pulls ? 'Pull requests' : 'Issues'}
        empty={<EmptyState icon={pulls ? GitPullRequest : CircleDot} title={`No open ${noun}`} description={`This repository has no open ${noun} on this device.`}/>}/>
    </>
  );
});

/**
 * A new pull request: the comparison of the default branch with a branch to choose (the code view). The link
 * preloads that view on intent like every link; the pointer on it also loads the editor and the people its
 * pickers offer, so the form paints complete.
 */
function NewPullButton({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  return (
    <Button size="sm" asChild tooltip="Choose the branches to merge">
      <CodeLink owner={owner} repo={repo} to="compare" onPointerEnter={() => {
        void preloadEditor().catch(() => undefined);
        loadPeople(app, repoId);
      }}><Icon icon={GitPullRequest} size="sm"/>New pull request</CodeLink>
    </Button>
  );
}

/**
 * The classic list's `type` (its "Assigned to you", "Created by you", "Mentioning you" tabs) in a typed or pasted
 * address: the same filter here (assignee or author = the viewer), or a notice that names where the rest lives.
 * Never ignored silently.
 */
function useClassicType(search: ListSearch & {type?: unknown}): void {
  const app = useApp();
  const navigate = useNavigate();
  const type = typeof search.type === 'string' ? search.type : undefined;
  useEffect(() => {
    if (!type) return;
    const me = app.session?.userId;
    const {type: _drop, ...rest} = search;
    const next: ListSearch = type === 'assigned' && me ? {...rest, assignee: me} : type === 'created_by' && me ? {...rest, poster: me} : rest;
    if (type !== 'assigned' && type !== 'created_by' && type !== 'your_repositories') {
      notify(app, {tone: 'neutral', title: 'That filter is not applied here',
        ...(type === 'mentioned' || type === 'review_requested' ? {description: 'My issues and My pull requests list what mentions you or waits for your review.'} : {})});
    }
    void navigate({to: '.', replace: true, search: next as never});
  }, [type, search, app, navigate]);
}

function RepoList({pulls, search}: {pulls: boolean; search: ListSearch}) {
  const {owner, repo, repoId} = useRepoPage();
  useClassicType(search);
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={pulls ? GitPullRequest : CircleDot} title={pulls ? 'Pull requests' : 'Issues'}/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  return <RepoListPage key={`${String(repoId)}:${String(pulls)}`} owner={owner} repo={repo} repoId={repoId} pulls={pulls} search={search}/>;
}

export function RepoIssues() {
  return <RepoList pulls={false} search={issuesApi.useSearch()}/>;
}

export function RepoPulls() {
  return <RepoList pulls search={pullsApi.useSearch()}/>;
}
