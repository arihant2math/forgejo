// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What every repository page shares: the repository the URL names (the
// route loader's id) with its group held while the page is open, the
// breadcrumb, and the page for a repository that is not available here.

import {Link, useLoaderData, useParams} from '@tanstack/react-router';
import {CloudOff, Slash} from 'lucide-react';
import {type RepoMatch, useHold} from '../../app/repo.ts';
import {AvailableOffline} from '../../app/Available.tsx';
import {connectivity} from '../../app/online.ts';
import {observer} from 'mobx-react-lite';
import {useSession} from '../../app/store.ts';
import {EmptyState, Icon, TextLink} from '../../ui/index.ts';

export function useRepoPage(): {owner: string; repo: string; repoId: number | undefined; group: string | undefined} {
  const {owner = '', repo = ''} = useParams({strict: false});
  const loaded: unknown = useLoaderData({strict: false});
  const repoId = (loaded as RepoMatch | undefined)?.repoId;
  const {data} = useSession();
  const group = repoId === undefined ? undefined : `repo:${String(repoId)}`;
  useHold(data, group);
  return {owner, repo, repoId, group};
}

/** The breadcrumb: owner / repository (a link to its issues, or its pull requests on pull request pages). */
export function RepoContext({owner, repo, pulls = false}: {owner: string; repo: string; pulls?: boolean}) {
  return (
    <>
      <span className="min-w-0 truncate">{owner}</span>
      <Icon icon={Slash} size="sm" className="text-fg-subtle"/>
      <TextLink><Link to={pulls ? '/$owner/$repo/pulls' : '/$owner/$repo/issues'} params={{owner, repo}}>{repo}</Link></TextLink>
    </>
  );
}

export const Unavailable = observer(function Unavailable() {
  const {data} = useSession();
  const offline = !connectivity.online || data.status.connection === 'offline';
  return (
    <EmptyState
      icon={CloudOff}
      title={offline ? 'Not available offline' : 'Not available here'}
      description={offline ? 'This repository is not on this device. Connect to load it, or open one of these:' : 'This repository does not exist, or you cannot see it.'}
      action={offline ? <AvailableOffline/> : undefined}
    />
  );
});
