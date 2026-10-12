// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The viewer's issues and pull requests across the workspace (/issues,
// /pulls): computed from the pool. "Mentioned" and "Review requested" come
// from tables the sync engine does not track, so the server's issue search
// names those issues (online) and the rows come from the pool.

import {getRouteApi, useNavigate} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import type {MyListSearch, MyListType} from '../../app/search.ts';
import {SegmentedControl} from '@primer/react';
import {Blankslate} from '@primer/react/experimental';
import {ListControls} from '../issues/ListBar.tsx';
import {ListBody, useListModel} from '../issues/ListPage.tsx';
import {IssueOpenedIcon, GitPullRequestIcon} from '@primer/octicons-react';

const TYPES: {type: MyListType | undefined; label: string}[] = [
  // Everything open in the repositories of the workspace (Forgejo's "In your repositories"), not only the viewer's own.
  {type: undefined, label: 'Your repositories'},
  {type: 'assigned', label: 'Assigned'},
  {type: 'created_by', label: 'Created'},
  {type: 'mentioned', label: 'Mentioned'},
];

const issuesApi = getRouteApi('/shell/issues');
const pullsApi = getRouteApi('/shell/pulls');

function Types({to, current, extra}: {to: '/issues' | '/pulls'; current: MyListType | undefined; extra?: {type: MyListType; label: string} | undefined}) {
  const navigate = useNavigate();
  const types = [...TYPES, ...(extra ? [extra] : [])];
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
  mentioned: 'Nothing open mentions you (this list needs a connection).',
  review_requested: 'Nobody is waiting for your review (this list needs a connection).',
};

/** One of the viewer's lists: the page owns the live query, which the header's controls and the list share. */
const MyList = observer(function MyList({pulls, search}: {pulls: boolean; search: MyListSearch}) {
  const model = useListModel({kind: 'my', pulls, type: search.type}, search, 'repo');
  return (
    <>
      <PageHeader icon={pulls ? GitPullRequestIcon : IssueOpenedIcon}
        title={<span className="inline-block whitespace-nowrap">{pulls ? 'My pull requests' : 'My issues'}</span>}
        docTitle={pulls ? 'My pull requests' : 'My issues'}>
        {/* Reserve the title's intrinsic width; the search gives way before controls wrap. */}
        <div className={pulls ? 'flex min-w-0 flex-wrap items-center gap-2' : 'contents'}>
          <Types to={pulls ? '/pulls' : '/issues'} current={search.type} extra={pulls ? {type: 'review_requested', label: 'Review requested'} : undefined}/>
          {/* Open / closed / all where every list has them (Linear's one place for the state). */}
          <ListControls model={model}/>
        </div>
      </PageHeader>
      <ListBody model={model} label={pulls ? 'My pull requests' : 'My issues'} showRepo
        empty={<Blankslate spacious><Blankslate.Visual>{pulls ? <GitPullRequestIcon size={24}/> : <IssueOpenedIcon size={24}/>}</Blankslate.Visual><Blankslate.Heading>All clear</Blankslate.Heading><Blankslate.Description>{DESCRIPTIONS[search.type ?? 'all']}</Blankslate.Description></Blankslate>}/>
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
