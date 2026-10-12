// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {observer} from 'mobx-react-lite';
import {useSession} from '../../app/store.ts';
import {RouterLinkButton} from '../../app/routerLinks.tsx';
import {CounterLabel} from '@primer/react';
import {MilestoneIcon, TagIcon} from '@primer/octicons-react';

export const IssueNav = observer(function IssueNav({owner, repo, repoId, current}: {owner: string; repo: string; repoId: number | undefined; current?: 'labels' | 'milestones' | undefined}) {
  const {data} = useSession();
  const pool = data.pool;
  let labels = 0;
  let milestones = 0;
  if (repoId !== undefined) {
    const r = pool.model('Repository').get(repoId);
    for (const l of pool.model('Label').by('repo_id', repoId)) if (!l.get('archived_at')) labels++;
    if (r) for (const l of pool.model('Label').by('org_id', r.get('owner_id'))) if (l.get('repo_id') === 0 && !l.get('archived_at')) labels++;
    for (const m of pool.model('Milestone').by('repo_id', repoId)) if (m.get('state') !== 'closed') milestones++;
  }
  const look = (on: boolean) => (on ? 'default' : 'invisible');
  return (
    <>
      <RouterLinkButton size="small" variant={look(current === 'labels')} leadingVisual={TagIcon} to="/$owner/$repo/labels" params={{owner, repo}} aria-current={current === 'labels' ? 'page' : undefined} activeProps={{}}>
          Labels{labels > 0 && <CounterLabel>{labels}</CounterLabel>}
        </RouterLinkButton>
      <RouterLinkButton size="small" variant={look(current === 'milestones')} leadingVisual={MilestoneIcon} to="/$owner/$repo/milestones" params={{owner, repo}} aria-current={current === 'milestones' ? 'page' : undefined} activeProps={{}}>
          Milestones{milestones > 0 && <CounterLabel>{milestones}</CounterLabel>}
        </RouterLinkButton>
    </>
  );
});
