// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {GitPullRequestIcon} from '@primer/octicons-react';
import {observer} from 'mobx-react-lite';
import {useApp} from '../../app/store.ts';
import {fetchCommits, poolCommits, type PullCommits, pullOf} from '../../code/pull.ts';
import {NotCached} from '../../code/source.ts';
import {EmptyState} from '../../components/EmptyState.tsx';
import type {Entity} from '../../data/entity.ts';
import type {PullRequest} from '../../protocol/types.gen.ts';
import {useLoad, useSource} from '../code/hooks.ts';
import {Unloaded} from '../code/states.tsx';
import {usePool} from '../../app/store.ts';
import {ChecksTab, CommitsTab} from './ChecksTab.tsx';
import {FilesTab} from './FilesTab.tsx';
import type {TabProps} from './types.ts';

export type PullTabName = 'files' | 'commits' | 'checks';

/** Cache API commit results as offline hints when the pool lacks them. */
function usePullCommits(issue: Entity<'Issue'>): {pr: PullRequest | undefined; commits: PullCommits | undefined; loading: ReturnType<typeof useLoad<PullCommits>>} {
  const pool = usePool();
  const app = useApp();
  const src = useSource();
  const pr = pullOf(pool, issue.id);
  const fromPool = pr ? poolCommits(pool, pr, issue.get('state') === 'open') : undefined;
  const loading = useLoad<PullCommits>(pr && !fromPool ? `prhint:${String(pr.id)}:${pr.merge_base}` : undefined, () => undefined, async () => {
    const c = pr ? await fetchCommits(app, src, pr) : undefined;
    if (!c) throw new NotCached('the head commit is not known on this device');
    return c;
  });
  return {pr, commits: fromPool ?? (loading.state === 'ready' ? loading.value : undefined), loading};
}

export const PullTab = observer(function PullTab({tab, ...props}: TabProps & {tab: PullTabName}) {
  const {pr, commits, loading} = usePullCommits(props.issue);
  if (!pr) return <EmptyState icon={GitPullRequestIcon} title="Not on this device" description="This pull request's details have not arrived yet."/>;
  if (!commits) return <Unloaded loaded={loading.state === 'ready' ? {state: 'loading'} : loading} what="This pull request's head"/>;
  switch (tab) {
    case 'files':
      return <FilesTab {...props} pr={pr} commits={commits}/>;
    case 'commits':
      return <CommitsTab {...props} pr={pr} commits={commits}/>;
    case 'checks':
      return <ChecksTab {...props} pr={pr} commits={commits}/>;
  }
});
