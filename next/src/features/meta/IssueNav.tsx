// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Labels and Milestones beside a repository's issue list, as GitHub has them
// (with their counts), and on those pages themselves, where the page's own
// one is current. Small on purpose: the issue list's chunk includes it.

import {Link} from '@tanstack/react-router';
import {Milestone as MilestoneIcon, Tag} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useSession} from '../../app/store.ts';
import {Button, Icon} from '../../ui/index.ts';

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
  const look = (on: boolean) => (on ? 'secondary' : 'ghost');
  return (
    <>
      <Button size="sm" variant={look(current === 'labels')} asChild tooltip="The repository's labels">
        <Link to="/$owner/$repo/labels" params={{owner, repo}} aria-current={current === 'labels' ? 'page' : undefined} activeProps={{}}>
          <Icon icon={Tag} size="sm"/>Labels{labels > 0 && <span className="text-fg-subtle tabular-nums">{labels}</span>}
        </Link>
      </Button>
      <Button size="sm" variant={look(current === 'milestones')} asChild tooltip="The repository's milestones">
        <Link to="/$owner/$repo/milestones" params={{owner, repo}} aria-current={current === 'milestones' ? 'page' : undefined} activeProps={{}}>
          <Icon icon={MilestoneIcon} size="sm"/>Milestones{milestones > 0 && <span className="text-fg-subtle tabular-nums">{milestones}</span>}
        </Link>
      </Button>
    </>
  );
});
