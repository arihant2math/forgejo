// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The viewer's issues and pull requests across the workspace (/issues,
// /pulls): computed from the pool. "Mentioned" and "Review requested" come
// from tables the sync engine does not track, so the server's issue search
// names those issues (online) and the rows come from the pool.

import {getRouteApi, Link} from '@tanstack/react-router';
import {CircleDot, GitPullRequest} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {reach} from '../../app/online.ts';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import type {ListState, MyListSearch, MyListType} from '../../app/search.ts';
import {useSession} from '../../app/store.ts';
import {Button, EmptyState} from '../../ui/index.ts';
import {ListControls} from '../issues/ListBar.tsx';
import {ListBody, useListModel} from '../issues/ListPage.tsx';
import type {IssueListModel} from '../issues/list.ts';

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
          {/* Exact search: "Your repositories" (no type) is not also current on a typed list (a subset match). */}
          <Link to={to} search={(prev) => {
            const {type: _type, ...rest} = prev as MyListSearch;
            return t.type ? {...rest, type: t.type} : rest;
          }} activeOptions={{exact: true}}>{t.label}</Link>
        </Button>
      ))}
    </>
  );
}

const DESCRIPTIONS: Record<string, string> = {
  all: 'Nothing open in the repositories on this device.',
  assigned: 'Nothing open is assigned to you.',
  created_by: 'You have not opened anything that is still open.',
};

/** What the server-assisted lists are about (not synced: the server names their items), and an answered empty list per state. */
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

/**
 * The empty state of one of the viewer's lists. Mentions and review requests come from Forgejo: an empty list says
 * it is empty only once Forgejo answered for the list's state (open, closed, all), and says it needs a connection
 * only when Forgejo could not be asked (QA #261: it said so always, online and answered too, which read as a failure).
 * The synced lists show this for their open state only (another state is a filter, see ListBody).
 */
export function emptyText(type: MyListType | undefined, pulls: boolean, state: ListState, server: IssueListModel['serverStatus'], reachable: ReturnType<typeof reach>): {title: string; description: string} {
  const assisted = type && assistedText(type, pulls);
  if (!assisted) return {title: 'All clear', description: DESCRIPTIONS[type ?? 'all'] ?? ''};
  // A stalled network: the question would only hang until its deadline.
  if (server === 'unanswered' || (server === 'asking' && reachable !== 'online')) {
    return {title: 'Needs a connection', description: `${assisted.what} are not kept on this device and Forgejo could not be asked. This list loads once Forgejo can be reached.`};
  }
  if (server === 'asking') return {title: 'Asking Forgejo…', description: `${assisted.what} are not kept on this device: Forgejo names them.`};
  return {title: 'All clear', description: assisted.empty[state]};
}

/** One of the viewer's lists: the page owns the live query, which the header's controls and the list share. */
const MyList = observer(function MyList({pulls, search}: {pulls: boolean; search: MyListSearch}) {
  const model = useListModel({kind: 'my', pulls, type: search.type}, search, 'repo');
  const {data} = useSession();
  const empty = emptyText(search.type, pulls, model.query.filter.state, model.serverStatus, reach(data.status.connection));
  return (
    <>
      <PageHeader icon={pulls ? GitPullRequest : CircleDot} title={pulls ? 'My pull requests' : 'My issues'}>
        <Types to={pulls ? '/pulls' : '/issues'} current={search.type} extra={pulls ? {type: 'review_requested', label: 'Review requested'} : undefined}/>
        {/* Open / closed / all where every list has them (Linear's one place for the state). */}
        <ListControls model={model}/>
      </PageHeader>
      <ListBody model={model} label={pulls ? 'My pull requests' : 'My issues'} showRepo emptyForEveryState={model.serverAssisted}
        empty={<EmptyState icon={pulls ? GitPullRequest : CircleDot} title={empty.title} description={empty.description}/>}/>
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
