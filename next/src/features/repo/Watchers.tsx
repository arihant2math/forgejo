// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {BorderBox} from '../../components/BorderBox.tsx';
import {ResourceRow} from '../../components/ResourceRow.tsx';
import {Avatar} from '@primer/react';

import {getRouteApi} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef} from 'react';
import {send} from '../../app/api.ts';
import {sitePath} from '../../app/config.ts';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {useApp} from '../../app/store.ts';
import {usePool} from '../issues/cells.tsx';
import {fullDate, shortDate} from '../../app/time.ts';
import {repoApi} from '../settings/requests.ts';
import {type Resource, useResource} from '../../app/resource.ts';
import {LoadState} from '../../components/LoadState.tsx';
import {settingsKey} from '../settings/resource.ts';
import {RepoHeader, Unavailable, useRepoPage} from './repoPage.tsx';
import {CalendarIcon, EyeIcon, LinkIcon, LocationIcon} from '@primer/octicons-react';
import {RouterLinkButton, PrimaryLink} from '../../app/routerLinks.tsx';
import {Pager} from '../../components/Pager.tsx';
import {EmptyState} from '../../components/EmptyState.tsx';

const watchersApi = getRouteApi('/shell/$owner/$repo/watchers');

/** Stay within API v1's default MAX_RESPONSE_ITEMS to preserve requested pagination. */
export const WATCHERS_PER_PAGE = 30;

export interface Watcher {
  id: number;
  login: string;
  full_name: string;
  avatar_url: string;
  website: string;
  location: string;
  /** Join time in RFC 3339 format. */
  created: string;
}

/** `total` is undefined when Forgejo omits X-Total-Count. */
export interface WatcherPage {
  users: Watcher[];
  total: number | undefined;
}

/** An empty list still has a first page. */
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / WATCHERS_PER_PAGE));
}

export function RepoWatchers() {
  const {owner, repo, repoId} = useRepoPage();
  if (repoId === undefined) {
    return (
      <>
        <RepoHeader owner={owner} repo={repo} repoId={undefined} icon={EyeIcon} title="Watchers"/>
        <PageBody><Unavailable owner={owner} repo={repo}/></PageBody>
      </>
    );
  }
  return (
    <>
      <RepoHeader owner={owner} repo={repo} repoId={repoId} icon={EyeIcon} title="Watchers"/>
      <PageBody>
        <PageColumn>
          <WatcherList key={repoId} owner={owner} repo={repo} repoId={repoId}/>
        </PageColumn>
      </PageBody>
    </>
  );
}

const WatcherList = observer(function WatcherList({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const page = watchersApi.useSearch().page ?? 1;
  const count = usePool().model('Repository').get(repoId)?.get('watchers_count');
  const res = useResource<WatcherPage>(settingsKey(repoId, `watchers:${String(page)}`), async (signal) => {
    const got = await send<Watcher[]>(app, {api: 'v1', path: `${repoApi(owner, repo)}/subscribers?limit=${String(WATCHERS_PER_PAGE)}&page=${String(page)}`, signal});
    return {users: got.value ?? [], total: got.totalCount};
  });
  const seen = useRef(count);
  const {reload} = res;
  useEffect(() => {
    if (seen.current === count) return;
    seen.current = count;
    reload();
  }, [count, reload]);
  const total = res.value?.total ?? count;
  const href = (n: number) => sitePath(app.config, `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/watchers${n > 1 ? `?page=${String(n)}` : ''}`);
  return (
    <BorderBox label="Watchers" title={<><EyeIcon size={16} className="shrink-0"/>Watchers{total !== undefined && <span className="tabular-nums">{total}</span>}</>}>
      <Body res={res} page={page} owner={owner} repo={repo}/>
      {/* Without a total, Forgejo's answer only says whether a next page exists. */}
      <Pager page={page} pageCount={total === undefined ? undefined : pageCount(total)} more={(res.value?.users.length ?? 0) >= WATCHERS_PER_PAGE}
        href={href} className="border-t border-muted px-4 py-2"/>
    </BorderBox>
  );
});

function Body({res, page, owner, repo}: {res: Resource<WatcherPage>; page: number; owner: string; repo: string}) {
  const v = res.value;
  if (v === undefined) return <LoadState res={res} what="The watchers"/>;
  if (!v.users.length) {
    return page > 1 ?
      <EmptyState spacious={false} icon={EyeIcon} title={`No watchers on page ${String(page)}`} action={<RouterLinkButton size="small" to="/$owner/$repo/watchers" params={{owner, repo}} search={{}}>First page</RouterLinkButton>}/> :
      <EmptyState spacious={false} icon={EyeIcon} title="No watchers" description="Nobody is watching this repository."/>;
  }
  return <div><ul>{v.users.map((u) => <WatcherCard key={u.id} u={u}/>)}</ul></div>;
}

function WatcherCard({u}: {u: Watcher}) {
  const name = u.full_name || u.login;
  const site = u.website && /^https?:\/\//i.test(u.website) ? u.website : undefined;
  return (
    <ResourceRow leading={<Avatar size={20} alt={u.login} src={u.avatar_url}/>}
      title={<PrimaryLink to="/$owner" params={{owner: u.login}} activeOptions={{exact: true}}>{name}</PrimaryLink>}
      meta={u.full_name ? u.login : undefined}
      description={site ?
        <span className="flex min-w-0 items-center gap-1"><LinkIcon size={16} className="shrink-0"/><a href={site} target="_blank" rel="noopener noreferrer" className="truncate text-accent hover:underline">{site}</a></span> :
        u.location ?
          <span className="flex min-w-0 items-center gap-1"><LocationIcon size={16} className="shrink-0"/><span className="truncate">{u.location}</span></span> :
          u.created ?
            <span className="flex items-center gap-1"><CalendarIcon size={16} className="shrink-0"/>Joined <time dateTime={u.created} title={fullDate(u.created)}>{shortDate(u.created)}</time></span> :
            undefined}/>
  );
}

