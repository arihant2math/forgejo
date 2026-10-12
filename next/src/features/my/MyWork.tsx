// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Mentions and review requests are not synced; server search supplies ids for pool rows.

import {getRouteApi, useNavigate} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {reach} from '../../app/online.ts';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import type {ListState, MyListSearch, MyListType} from '../../app/search.ts';
import {useSession} from '../../app/store.ts';
import {SegmentedControl} from '@primer/react';
import {ListControls} from '../issues/ListBar.tsx';
import {ListBody, useListModel} from '../issues/ListPage.tsx';
import type {IssueListModel} from '../issues/list.ts';
import {IssueOpenedIcon, GitPullRequestIcon} from '@primer/octicons-react';
import {EmptyState} from '../../components/EmptyState.tsx';

/** GitHub's order and wording; Forgejo's own view of every repository on this device comes last. */
const TYPES: {type: MyListType | undefined; label: string}[] = [
  {type: 'created_by', label: 'Created'},
  {type: 'assigned', label: 'Assigned'},
  {type: 'mentioned', label: 'Mentioned'},
];
const REVIEWS = {type: 'review_requested', label: 'Review requests'} as const;
const ALL = {type: undefined, label: 'Your repositories'};

const issuesApi = getRouteApi('/shell/issues');
const pullsApi = getRouteApi('/shell/pulls');

function Types({to, current}: {to: '/issues' | '/pulls'; current: MyListType | undefined}) {
  const navigate = useNavigate();
  const types = [...TYPES, ...(to === '/pulls' ? [REVIEWS] : []), ALL];
  return <SegmentedControl aria-label="My work filter" size="small" onChange={(index) => {
    const target = index === undefined ? undefined : types[index];
    if (!target) return;
    void navigate({to, search: (prev) => {
      const {type: _type, ...rest} = prev as MyListSearch;
      return target.type ? {...rest, type: target.type} : rest;
    }});
  }}>
    {types.map((entry) => <SegmentedControl.Button key={entry.label} selected={current === entry.type}>{entry.label}</SegmentedControl.Button>)}
  </SegmentedControl>;
}

const DESCRIPTIONS: Record<string, string> = {
  all: 'Nothing open in the repositories on this device.',
  assigned: 'Nothing open is assigned to you.',
  created_by: 'You have not opened anything that is still open.',
};

function assistedText(type: MyListType, pulls: boolean): {what: string; empty: Record<ListState, string>} | undefined {
  const closed = pulls ? 'Closed and merged pull requests' : 'Closed issues';
  const hint = `${closed} are not listed here: choose All to see them.`;
  switch (type) {
    case 'review_requested':
      return {what: 'Review requests', empty: {
        open: `Nothing open is waiting for your review. ${hint}`,
        closed: 'No closed or merged pull request is waiting for your review.',
        all: 'Nothing is waiting for your review, open, closed or merged.',
      }};
    case 'mentioned':
      return {what: 'Mentions', empty: {
        open: `Nothing open mentions you. ${hint}`,
        closed: pulls ? 'No closed or merged pull request mentions you.' : 'No closed issue mentions you.',
        all: pulls ? 'No pull request mentions you, open, closed or merged.' : 'No issue mentions you, open or closed.',
      }};
    default:
      return undefined;
  }
}

/** Server-assisted lists are empty only after an answer for the requested state; otherwise report reachability. */
export function emptyText(type: MyListType | undefined, pulls: boolean, state: ListState, server: IssueListModel['serverStatus'], reachable: ReturnType<typeof reach>): {title: string; description: string} {
  const assisted = type && assistedText(type, pulls);
  if (!assisted) return {title: 'All clear', description: DESCRIPTIONS[type ?? 'all'] ?? ''};
  if (server === 'unanswered' || (server === 'asking' && reachable !== 'online')) {
    return {title: 'Needs a connection', description: `${assisted.what} are not kept on this device and Forgejo could not be asked. This list loads once Forgejo can be reached.`};
  }
  if (server === 'asking') return {title: 'Asking Forgejo…', description: `${assisted.what} are not kept on this device: Forgejo names them.`};
  return {title: 'All clear', description: assisted.empty[state]};
}

const MyList = observer(function MyList({pulls, search}: {pulls: boolean; search: MyListSearch}) {
  const model = useListModel({kind: 'my', pulls, type: search.type}, search, 'repo');
  const {data} = useSession();
  const empty = emptyText(search.type, pulls, model.query.filter.state, model.serverStatus, reach(data.status.connection));
  return (
    <>
      <PageHeader icon={pulls ? GitPullRequestIcon : IssueOpenedIcon}
        title={<span className="inline-block whitespace-nowrap">{pulls ? 'My pull requests' : 'My issues'}</span>}
        docTitle={pulls ? 'My pull requests' : 'My issues'}>
        {/* Reserve the title's intrinsic width; the search gives way before controls wrap. */}
        <div className={pulls ? 'flex min-w-0 flex-wrap items-center gap-2' : 'contents'}>
          <Types to={pulls ? '/pulls' : '/issues'} current={search.type}/>
          <ListControls model={model}/>
        </div>
      </PageHeader>
      <ListBody model={model} label={pulls ? 'My pull requests' : 'My issues'} showRepo emptyForEveryState={model.serverAssisted}
        empty={<EmptyState icon={pulls ? GitPullRequestIcon : IssueOpenedIcon} title={empty.title} description={empty.description}/>}/>
    </>
  );
});

export function MyIssues() {
  const search = issuesApi.useSearch();
  return <MyList key={search.type ?? 'all'} pulls={false} search={search}/>;
}

export function MyPulls() {
  const search = pullsApi.useSearch();
  return <MyList key={search.type ?? 'all'} pulls search={search}/>;
}
