// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What a repository's issues can be given, as far as this device knows: the
// pickers and the list filters offer these.

import type {Pool} from '../../data/pool.ts';
import type {Label} from '../../protocol/types.gen.ts';

/** The labels a repository's issues can have: its own and its owner organization's, not archived. */
export function repoLabels(pool: Pool, repoId: number): Label[] {
  const repo = pool.model('Repository').get(repoId);
  const out: Label[] = [];
  for (const l of pool.model('Label').by('repo_id', repoId)) out.push(l.data);
  if (repo) for (const l of pool.model('Label').by('org_id', repo.data.owner_id)) if (l.data.repo_id === 0) out.push(l.data);
  return out.filter((l) => !l.archived_at).sort((a, b) => a.name.localeCompare(b.name));
}

/** Who can be assigned in a repository, as far as this device knows: collaborators, team members, the owner, the viewer. */
export function assigneeCandidates(pool: Pool, repoId: number, me: number): number[] {
  const ids = new Set<number>([me]);
  for (const c of pool.model('Collaboration').by('repo_id', repoId)) ids.add(c.data.user_id);
  const repo = pool.model('Repository').get(repoId)?.data;
  if (repo && pool.model('User').get(repo.owner_id)?.data.type === 'user') ids.add(repo.owner_id);
  for (const tr of pool.model('TeamRepo').by('repo_id', repoId)) {
    for (const tu of pool.model('TeamUser').by('team_id', tr.data.team_id)) ids.add(tu.data.user_id);
  }
  // Teams with every repository of the organization have no TeamRepo rows.
  if (repo) {
    for (const t of pool.model('Team').by('org_id', repo.owner_id)) {
      if (!t.data.includes_all_repositories) continue;
      for (const tu of pool.model('TeamUser').by('team_id', t.id)) ids.add(tu.data.user_id);
    }
  }
  return [...ids];
}

