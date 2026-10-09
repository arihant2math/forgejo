// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The viewer's issues and pull requests across the workspace (/issues,
// /pulls): computed from the pool. "Mentioned" and "Review requested" come
// from tables the sync engine does not track, so the server's issue search
// names those issues (online) and the rows come from the pool.

import {getRouteApi, Link} from '@tanstack/react-router';
import {CircleDot, GitPullRequest} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import type {MyListSearch, MyListType} from '../../app/search.ts';
import {Button, EmptyState} from '../../ui/index.ts';
import {ListControls} from '../issues/ListBar.tsx';
import {ListBody, useListModel} from '../issues/ListPage.tsx';

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
  return (
    <>
      {[...TYPES, ...extra ? [extra] : []].map((t) => (
        <Button key={t.label} asChild size="sm" variant={current === t.type ? 'secondary' : 'ghost'}>
          <Link to={to} search={(prev) => {
            const {type: _type, ...rest} = prev;
            return t.type ? {...rest, type: t.type} : rest;
          }} aria-current={current === t.type ? 'page' : undefined}>{t.label}</Link>
        </Button>
      ))}
    </>
  );
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
      <PageHeader icon={pulls ? GitPullRequest : CircleDot} title={pulls ? 'My pull requests' : 'My issues'}>
        <Types to={pulls ? '/pulls' : '/issues'} current={search.type} extra={pulls ? {type: 'review_requested', label: 'Review requested'} : undefined}/>
        <ListControls model={model} stateButtons={false}/>
      </PageHeader>
      <ListBody model={model} label={pulls ? 'My pull requests' : 'My issues'} showRepo
        empty={<EmptyState icon={pulls ? GitPullRequest : CircleDot} title="All clear" description={DESCRIPTIONS[search.type ?? 'all']}/>}/>
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
