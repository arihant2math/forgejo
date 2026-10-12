// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {getRouteApi, useNavigate} from '@tanstack/react-router';
import {useEffect} from 'react';
import {runInAction} from 'mobx';
import {loadTemplates} from '../create/templates.ts';
import {notify} from '../../app/notices.ts';
import {useApp} from '../../app/store.ts';
import {openCreate} from '../../app/create.ts';
import {shortcutHint} from '../../app/shortcuts/index.ts';
import {observer} from 'mobx-react-lite';
import {PageBody} from '../../app/shell/Frame.tsx';
import type {ListSearch} from '../../app/search.ts';
import {Blankslate} from '@primer/react/experimental';
import {preloadEditor} from '../editor/Composer.tsx';
import {codeTo} from '../code/nav.tsx';
import {RouterLinkButton} from '../../app/routerLinks.tsx';
import {loadPeople} from '../issues/people.ts';
import {ListControls} from '../issues/ListBar.tsx';
import {ListBody, useListModel} from '../issues/ListPage.tsx';
import {IssueNav} from '../meta/IssueNav.tsx';
import {RepoHeader, Unavailable, useRepoPage} from './repoPage.tsx';
import {IssueOpenedIcon, GitPullRequestIcon, PencilIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';
import {Tooltip} from '@primer/react';

const issuesApi = getRouteApi('/shell/$owner/$repo/issues');
const pullsApi = getRouteApi('/shell/$owner/$repo/pulls');
const newIssueApi = getRouteApi('/shell/$owner/$repo/issues/new');

export function NewIssue() {
  const app = useApp();
  const {owner, repo, repoId} = useRepoPage();
  const {template} = newIssueApi.useSearch();
  useEffect(() => {
    if (!repoId) return;
    runInAction(() => { app.ui.create = {repoId, ...(template ? {template} : {})}; });
  }, [app, repoId, template]);
  if (repoId === undefined) return <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>;
  return <RepoListPage owner={owner} repo={repo} repoId={repoId} pulls={false} search={{}}/>;
}

/** The header controls and list share this page's live query. */
const RepoListPage = observer(function RepoListPage({owner, repo, repoId, pulls, search}: {owner: string; repo: string; repoId: number; pulls: boolean; search: ListSearch}) {
  const app = useApp();
  const model = useListModel({kind: 'repo', repoId, pulls}, search, 'none');
  const noun = pulls ? 'pull requests' : 'issues';
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={pulls ? GitPullRequestIcon : IssueOpenedIcon} title={pulls ? 'Pull requests' : 'Issues'}>
        <ListControls model={model} repoId={repoId} hideGroups={['repo']}/>
        <IssueNav owner={owner} repo={repo} repoId={repoId}/>
        {/* Pull requests start from a comparison so their branches can be chosen there. */}
        {pulls ?
          <NewPullButton owner={owner} repo={repo} repoId={repoId}/> :
          <Tooltip text={'New issue'} keybindingHint={shortcutHint('create')}><Button variant="primary" size="small" leadingVisual={PencilIcon} type="button" aria-label="New issue" onPointerEnter={() => { void loadTemplates(app, repoId); }} onClick={() => {
            openCreate(app, repoId);
          }}><span className="@max-md:hidden">New issue</span></Button></Tooltip>}
      </RepoHeader>
      <ListBody model={model} label={pulls ? 'Pull requests' : 'Issues'}
        empty={<Blankslate><Blankslate.Visual>{pulls ? <GitPullRequestIcon/> : <IssueOpenedIcon/>}</Blankslate.Visual><Blankslate.Heading>{`No open ${noun}`}</Blankslate.Heading><Blankslate.Description>{`This repository has no open ${noun} on this device.`}</Blankslate.Description></Blankslate>}/>
    </>
  );
});

/** Prefetch the editor and picker data on intent so the comparison form paints complete. */
function NewPullButton({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  return (
    <Tooltip text={'Choose the branches to merge'}><RouterLinkButton variant="primary" size="small" leadingVisual={GitPullRequestIcon} {...codeTo(owner, repo, 'compare')} onPointerEnter={() => {
        void preloadEditor().catch(() => undefined);
        loadPeople(app, repoId);
      }}>New pull request</RouterLinkButton></Tooltip>
  );
}

/** Map classic `type` filters to the viewer; unsupported filters must show a notice. */
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
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={pulls ? GitPullRequestIcon : IssueOpenedIcon} title={pulls ? 'Pull requests' : 'Issues'}/>
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
