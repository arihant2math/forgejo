// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Repository pages (/{owner}/{repo}/issues, /pulls and one issue or pull
// request). F3 provides the pages, their data loading (the repository's
// group is held while one is open) and the header; F4 renders the lists and
// the timeline.

import {Link, useLoaderData, useParams} from '@tanstack/react-router';
import {CircleCheck, CircleDot, CloudOff, GitPullRequest, GitPullRequestClosed} from 'lucide-react';
import {untracked} from 'mobx';
import {observer} from 'mobx-react-lite';
import type {ReactNode} from 'react';
import {type RepoMatch, useHold} from '../../app/repo.ts';
import {PageBody} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {useSession} from '../../app/store.ts';
import {Badge, EmptyState} from '../../ui/index.ts';

function useRepoPage(): {owner: string; repo: string; repoId: number | undefined; group: string | undefined} {
  const {owner = '', repo = ''} = useParams({strict: false});
  const loaded: unknown = useLoaderData({strict: false});
  const repoId = (loaded as RepoMatch | undefined)?.repoId;
  const {data} = useSession();
  const group = repoId === undefined ? undefined : `repo:${String(repoId)}`;
  useHold(data, group);
  return {owner, repo, repoId, group};
}

function RepoContext({owner, repo}: {owner: string; repo: string}) {
  return <>{owner}<span aria-hidden>/</span><Link to="/$owner/$repo/issues" params={{owner, repo}} className="truncate">{repo}</Link></>;
}

function Unavailable() {
  return (
    <EmptyState
      icon={CloudOff}
      title="Not available here"
      description={navigator.onLine ? 'This repository does not exist, or you cannot see it.' : 'This repository is not on this device. Connect to load it.'}
    />
  );
}

function RepoList({kind, empty}: {kind: 'issues' | 'pulls'; empty: ReactNode}) {
  const {owner, repo, repoId} = useRepoPage();
  return (
    <>
      <PageHeader icon={kind === 'issues' ? CircleDot : GitPullRequest} context={<RepoContext owner={owner} repo={repo}/>}
        title={kind === 'issues' ? 'Issues' : 'Pull requests'}/>
      <PageBody>{repoId === undefined ? <Unavailable/> : empty}</PageBody>
    </>
  );
}

export function RepoIssues() {
  return <RepoList kind="issues" empty={<EmptyState icon={CircleDot} title="Issues show here" description="The issue list is on its way. Find an issue with the command menu."/>}/>;
}

export function RepoPulls() {
  return <RepoList kind="pulls" empty={<EmptyState icon={GitPullRequest} title="Pull requests show here" description="The pull request list is on its way. Find one with the command menu."/>}/>;
}

/** The issue of a repository by number: reacts to issues arriving or leaving, and to that issue's fields only. */
const IssueHeader = observer(function IssueHeader({repoId, index, context}: {repoId: number; index: number; context: ReactNode}) {
  const {data} = useSession();
  const set = data.pool.model('Issue').by('repo_id', repoId);
  // Membership is tracked (above); scanning the numbers is not, so the
  // header does not observe every issue of the repository.
  const issue = untracked(() => {
    for (const e of set) if (e.data.number === index) return e;
    return undefined;
  });
  const title = issue?.get('title');
  const open = issue?.get('state') === 'open';
  const pull = issue?.get('is_pull') ?? false;
  const icon = pull ? (open ? GitPullRequest : GitPullRequestClosed) : (open ? CircleDot : CircleCheck);
  return (
    <PageHeader icon={icon} context={context} title={title ? <>{title} <span className="text-fg-subtle">#{index}</span></> : `#${String(index)}`}>
      {issue && <Badge tone={open ? 'success' : 'done'}>{open ? 'Open' : 'Closed'}</Badge>}
    </PageHeader>
  );
});

export function IssueView() {
  const {owner, repo, repoId} = useRepoPage();
  const {index: raw = ''} = useParams({strict: false});
  const index = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : 0;
  const context = <RepoContext owner={owner} repo={repo}/>;
  return (
    <>
      {repoId === undefined ?
        <PageHeader context={context} title={`#${String(index)}`}/> :
        <IssueHeader repoId={repoId} index={index} context={context}/>}
      <PageBody>
        {repoId === undefined ? <Unavailable/> : <EmptyState icon={CircleDot} title="The conversation shows here" description="The timeline is on its way."/>}
      </PageBody>
    </>
  );
}
