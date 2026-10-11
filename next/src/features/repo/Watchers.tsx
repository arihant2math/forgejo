// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's watchers (/{owner}/{repo}/watchers, the classic page's
// address): the people who watch it, as the classic user cards show them —
// avatar, name (their profile), and their website, else their location, else
// when they joined — a page at a time (`?page=`, as the classic pagination).
// API v1 lists them (online; the last answer is kept for the next visit and
// shown offline); the count is the repository's own (the pool's).

import {getRouteApi, Link} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef} from 'react';
import {send} from '../../app/api.ts';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {useApp} from '../../app/store.ts';
import {Avatar, Button, Callout, EmptyState, Entry, EntryList, Panel} from '../../ui/index.ts';
import {usePool} from '../issues/cells.tsx';
import {fullDate, shortDate} from '../issues/format.ts';
import {ListSkeleton} from '../settings/bits.tsx';
import {repoApi} from '../settings/requests.ts';
import {type Resource, settingsKey, useResource} from '../settings/resource.ts';
import {RepoHeader, Unavailable, useRepoPage} from './repoPage.tsx';
import {CalendarIcon, EyeIcon, LinkIcon, LocationIcon} from '@primer/octicons-react';

const watchersApi = getRouteApi('/shell/$owner/$repo/watchers');

/** Watchers a page lists (within API v1's default MAX_RESPONSE_ITEMS, so that Forgejo pages them as asked). */
export const WATCHERS_PER_PAGE = 30;

/** API v1's User, the fields a watcher's card shows. */
export interface Watcher {
  id: number;
  login: string;
  full_name: string;
  avatar_url: string;
  website: string;
  location: string;
  /** When they joined (RFC 3339). */
  created: string;
}

/** One page of watchers and how many there are in all (X-Total-Count; undefined when Forgejo did not say). */
export interface WatcherPage {
  users: Watcher[];
  total: number | undefined;
}

/** How many pages `total` watchers fill (at least one: the first page says there are none). */
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
  // Someone (the viewer: the header's Watch) started or stopped watching: the list is asked again.
  const seen = useRef(count);
  const {reload} = res;
  useEffect(() => {
    if (seen.current === count) return;
    seen.current = count;
    reload();
  }, [count, reload]);
  const total = res.value?.total ?? count;
  const last = total === undefined ? undefined : pageCount(total);
  const more = last === undefined ? (res.value?.users.length ?? 0) >= WATCHERS_PER_PAGE : page < last;
  const to = (n: number) => ({to: '/$owner/$repo/watchers', params: {owner, repo}, search: n > 1 ? {page: n} : {}}) as const;
  return (
    <Panel label="Watchers" title={<><EyeIcon size={12} className="shrink-0"/>Watchers{total !== undefined && <span className="tabular-nums">{total}</span>}</>}>
      <Body res={res} page={page} owner={owner} repo={repo}/>
      {(page > 1 || more) && (
        <nav aria-label="Pages" className="flex items-center gap-2 border-t border-border-subtle px-3 py-2">
          {page > 1 ? <Button asChild size="sm"><Link {...to(page - 1)}>Previous</Link></Button> : <Button size="sm" disabled>Previous</Button>}
          <span className="text-sm text-fg-muted tabular-nums">{last === undefined ? `Page ${String(page)}` : `Page ${String(page)} of ${String(last)}`}</span>
          {more ? <Button asChild size="sm"><Link {...to(page + 1)}>Next</Link></Button> : <Button size="sm" disabled>Next</Button>}
        </nav>
      )}
    </Panel>
  );
});

function Body({res, page, owner, repo}: {res: Resource<WatcherPage>; page: number; owner: string; repo: string}) {
  const v = res.value;
  if (v === undefined) {
    if (res.state === 'loading') return <div className="px-3"><ListSkeleton/></div>;
    if (res.state === 'offline') return <EmptyState icon={EyeIcon} title="Not on this device yet" description="The watchers load when you are online."/>;
    return (
      <Callout tone="danger" title="The watchers could not be loaded" actions={<Button size="sm" onClick={res.reload}>Try again</Button>}>
        {res.error}
      </Callout>
    );
  }
  if (!v.users.length) {
    return page > 1 ?
      <EmptyState icon={EyeIcon} title={`No watchers on page ${String(page)}`} action={<Button asChild size="sm"><Link to="/$owner/$repo/watchers" params={{owner, repo}} search={{}}>First page</Link></Button>}/> :
      <EmptyState icon={EyeIcon} title="No watchers" description="Nobody is watching this repository."/>;
  }
  return <div className="px-3"><EntryList>{v.users.map((u) => <WatcherCard key={u.id} u={u}/>)}</EntryList></div>;
}

/** A watcher, as the classic user card: their website, else their location, else when they joined. */
function WatcherCard({u}: {u: Watcher}) {
  const name = u.full_name || u.login;
  const site = u.website && /^https?:\/\//i.test(u.website) ? u.website : undefined;
  return (
    <Entry leading={<Avatar name={u.login} src={u.avatar_url}/>}
      title={<Link to="/$owner" params={{owner: u.login}} className="font-medium hover:text-accent-fg">{name}</Link>}
      meta={u.full_name ? u.login : undefined}
      description={site ?
        <span className="flex min-w-0 items-center gap-1"><LinkIcon size={12} className="shrink-0"/><a href={site} target="_blank" rel="noopener noreferrer" className="truncate hover:text-accent-fg">{site}</a></span> :
        u.location ?
          <span className="flex min-w-0 items-center gap-1"><LocationIcon size={12} className="shrink-0"/><span className="truncate">{u.location}</span></span> :
          u.created ?
            <span className="flex items-center gap-1"><CalendarIcon size={12} className="shrink-0"/>Joined <time dateTime={u.created} title={fullDate(u.created)}>{shortDate(u.created)}</time></span> :
            undefined}/>
  );
}
