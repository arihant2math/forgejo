// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What every repository page shares: the repository the URL names (the
// route loader's id) with its group held while the page is open, the
// breadcrumb, and the page for a repository that is not available here.

import {Link, useLoaderData, useParams} from '@tanstack/react-router';
import {CloudOff, Slash} from 'lucide-react';
import {type RepoMatch, useHold} from '../../app/repo.ts';
import {useSession} from '../../app/store.ts';
import {EmptyState, Icon} from '../../ui/index.ts';

export function useRepoPage(): {owner: string; repo: string; repoId: number | undefined; group: string | undefined} {
  const {owner = '', repo = ''} = useParams({strict: false});
  const loaded: unknown = useLoaderData({strict: false});
  const repoId = (loaded as RepoMatch | undefined)?.repoId;
  const {data} = useSession();
  const group = repoId === undefined ? undefined : `repo:${String(repoId)}`;
  useHold(data, group);
  return {owner, repo, repoId, group};
}

export function RepoContext({owner, repo}: {owner: string; repo: string}) {
  return (
    <>
      <span className="min-w-0 truncate">{owner}</span>
      <Icon icon={Slash} size="sm" className="text-fg-subtle"/>
      <Link to="/$owner/$repo/issues" params={{owner, repo}} className="interactive min-w-0 truncate hover:text-fg">{repo}</Link>
    </>
  );
}

export function Unavailable() {
  return (
    <EmptyState
      icon={CloudOff}
      title="Not available here"
      description={navigator.onLine ? 'This repository does not exist, or you cannot see it.' : 'This repository is not on this device. Connect to load it.'}
    />
  );
}
