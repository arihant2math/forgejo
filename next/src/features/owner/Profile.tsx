// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {BorderBox} from '../../components/BorderBox.tsx';
import {Avatar} from '@primer/react';

import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {failureText, online, RequestFailed} from '../../app/api.ts';
import {reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {ContributionHeatmap} from './ContributionHeatmap.tsx';
import {FeedPage} from '../home/Feed.tsx';
import {allPages} from '../settings/requests.ts';
import {useResource} from '../../app/resource.ts';
import {LoadState} from '../../components/LoadState.tsx';
import {PeopleIcon, RepoIcon, PulseIcon} from '@primer/octicons-react';
import {Button, SegmentedControl} from '@primer/react';
import {PrimaryLink} from '../../app/routerLinks.tsx';

export const Follow = observer(function Follow({owner}: {owner: string}) {
  const app = useApp();
  const {data} = useSession();
  const connected = reach(data.status.connection) === 'online';
  const path = `/user/following/${encodeURIComponent(owner)}`;
  const res = useResource(`profile-follow:${owner}`, async (signal) => {
    try { await online(app, {api: 'v1', path, signal}); return true; }
    catch (err) { if (err instanceof RequestFailed && err.status === 404) return false; throw err; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = async () => {
    setBusy(true); setError('');
    try {
      await online(app, {api: 'v1', path, method: res.value ? 'DELETE' : 'PUT'});
      res.update((v) => !v);
    } catch (err) { setError(failureText(err)); }
    finally { setBusy(false); }
  };
  return <div><Button block type="button" disabled={!connected || !res.fresh || busy} onClick={() => { void change(); }}>{res.value ? 'Unfollow' : 'Follow'}</Button>{error && <p role="alert">{error}</p>}</div>;
});

interface Person {id: number; login: string; full_name: string; avatar_url: string}
export const People = observer(function People({owner, isOrg}: {owner: string; isOrg: boolean}) {
  const app = useApp();
  const [kind, setKind] = useState('followers');
  const path = isOrg ? `/orgs/${encodeURIComponent(owner)}/members` : `/users/${encodeURIComponent(owner)}/${kind}`;
  const res = useResource(`profile-people:${path}`, (signal) => allPages<Person>(app, path, signal));
  return <BorderBox label="People" title={isOrg ? 'People' : 'Followers and following'}>
    {!isOrg && <div className="px-4 py-2"><SegmentedControl size="small" aria-label="People" onChange={(index) => { setKind(index === 1 ? 'following' : 'followers'); }}><SegmentedControl.Button selected={kind === 'followers'}>Followers</SegmentedControl.Button><SegmentedControl.Button selected={kind === 'following'}>Following</SegmentedControl.Button></SegmentedControl></div>}
    <LoadState res={res} what="The people" empty={{icon: PeopleIcon, title: 'No people to show', description: 'None that you can see.'}}>
      {(people) => <div className="flex flex-col">{people.map((p) => <PrimaryLink key={p.id} to="/$owner" params={{owner: p.login}} className="flex items-center gap-2 border-b border-muted px-4 py-2 last:border-b-0"><Avatar size={20} alt={p.login} src={p.avatar_url}/><span>{p.full_name || p.login}</span><span className="text-muted">{p.login}</span></PrimaryLink>)}</div>}
    </LoadState>
  </BorderBox>;
});

export const Overview = observer(function Overview({owner}: {owner: string}) {
  const {data} = useSession();
  const connected = reach(data.status.connection) === 'online';
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); observer.disconnect(); }
    });
    observer.observe(ref.current);
    return () => { observer.disconnect(); };
  }, []);
  return <div ref={ref} className="flex flex-col gap-4">
    {visible && <><Heatmap owner={owner}/><Popular owner={owner}/><BorderBox label="Recent activity" title="Recent activity"><FeedPage context="" login={owner} connected={connected} performedOnly/></BorderBox></>}
  </div>;
});

const Heatmap = observer(function Heatmap({owner}: {owner: string}) {
  const app = useApp();
  const res = useResource(`profile-heatmap:${owner}`, async (signal) => await online<{timestamp: number; contributions: number}[]>(app, {api: 'v1', path: `/users/${encodeURIComponent(owner)}/heatmap`, signal}) ?? []);
  return <BorderBox label="Contributions" title="Contributions"><LoadState res={res} what="Contributions" empty={{icon: PulseIcon, title: 'No contributions', description: 'No activity in the last year.'}}>{(rows) => <ContributionHeatmap rows={rows}/>}</LoadState></BorderBox>;
});

const Popular = observer(function Popular({owner}: {owner: string}) {
  const app = useApp();
  const res = useResource(`profile-popular:${owner}`, async (signal) => {
    const rows = await allPages<{id: number; name: string; owner: {login: string}; stars_count: number; description: string}>(app, `/users/${encodeURIComponent(owner)}/repos`, signal);
    return rows.sort((a, b) => b.stars_count - a.stars_count).slice(0, 6);
  });
  return <BorderBox label="Popular repositories" title="Popular repositories"><LoadState res={res} what="Repositories" empty={{icon: RepoIcon, title: 'No repositories', description: 'None that you can see.'}}>{(rows) => <div className="flex flex-col">{rows.map((r) => <PrimaryLink key={r.id} to="/$owner/$repo" params={{owner: r.owner.login, repo: r.name}} className="flex flex-col gap-1 border-b border-muted px-4 py-3 last:border-b-0"><span className="flex items-center gap-2"><span className="font-semibold">{r.name}</span><span className="text-sm text-muted">· {r.stars_count} stars</span></span><span className="text-base text-muted">{r.description}</span></PrimaryLink>)}</div>}</LoadState></BorderBox>;
});

