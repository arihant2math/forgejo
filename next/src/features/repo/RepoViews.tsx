// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Repository list pages (/{owner}/{repo}/issues, /pulls): the repository's
// group is held while one is open; the list is computed from the pool
// (features/issues). One issue or pull request is features/issue
// (its own chunk).

import {getRouteApi} from '@tanstack/react-router';
import {CircleDot, GitPullRequest} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {PageBody} from '../../app/shell/Frame.tsx';
import type {ListSearch} from '../../app/search.ts';
import {EmptyState} from '../../ui/index.ts';
import {ListControls} from '../issues/ListBar.tsx';
import {ListBody, useListModel} from '../issues/ListPage.tsx';
import {RepoHeader, Unavailable, useRepoPage} from './repoPage.tsx';

const issuesApi = getRouteApi('/shell/$owner/$repo/issues');
const pullsApi = getRouteApi('/shell/$owner/$repo/pulls');

/** One repository's list: the page owns the live query, which the header's controls and the list share. */
const RepoListPage = observer(function RepoListPage({owner, repo, repoId, pulls, search}: {owner: string; repo: string; repoId: number; pulls: boolean; search: ListSearch}) {
  const model = useListModel({kind: 'repo', repoId, pulls}, search, 'none');
  const noun = pulls ? 'pull requests' : 'issues';
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={pulls ? GitPullRequest : CircleDot} title={pulls ? 'Pull requests' : 'Issues'}>
        <ListControls model={model} repoId={repoId} hideGroups={['repo']}/>
      </RepoHeader>
      <ListBody model={model} label={pulls ? 'Pull requests' : 'Issues'}
        empty={<EmptyState icon={pulls ? GitPullRequest : CircleDot} title={`No open ${noun}`} description={`This repository has no open ${noun} on this device.`}/>}/>
    </>
  );
});

function RepoList({pulls, search}: {pulls: boolean; search: ListSearch}) {
  const {owner, repo, repoId} = useRepoPage();
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
