// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The viewer's issues and pull requests across repositories (/issues,
// /pulls). F3 provides the page and its typed filters; F4 renders the list.

import {getRouteApi, Link} from '@tanstack/react-router';
import {CircleDot, GitPullRequest} from 'lucide-react';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import type {MyListType} from '../../app/search.ts';
import {Button, EmptyState} from '../../ui/index.ts';

const TYPES: {type: MyListType | undefined; label: string}[] = [
  {type: undefined, label: 'All'},
  {type: 'assigned', label: 'Assigned'},
  {type: 'created_by', label: 'Created'},
  {type: 'mentioned', label: 'Mentioned'},
];

const issuesApi = getRouteApi('/shell/issues');
const pullsApi = getRouteApi('/shell/pulls');

function Filters({to, current, extra}: {to: '/issues' | '/pulls'; current: MyListType | undefined; extra?: {type: MyListType; label: string}}) {
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

export function MyIssues() {
  const {type} = issuesApi.useSearch();
  return (
    <>
      <PageHeader icon={CircleDot} title="My issues"><Filters to="/issues" current={type}/></PageHeader>
      <PageBody>
        <EmptyState icon={CircleDot} title="Your issues show here" description="The issue list is on its way. Until then, find any issue with the command menu."/>
      </PageBody>
    </>
  );
}

export function MyPulls() {
  const {type} = pullsApi.useSearch();
  return (
    <>
      <PageHeader icon={GitPullRequest} title="My pull requests">
        <Filters to="/pulls" current={type} extra={{type: 'review_requested', label: 'Review requested'}}/>
      </PageHeader>
      <PageBody>
        <EmptyState icon={GitPullRequest} title="Your pull requests show here" description="The pull request list is on its way. Until then, find any pull request with the command menu."/>
      </PageBody>
    </>
  );
}
