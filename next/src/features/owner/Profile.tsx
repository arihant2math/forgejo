// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Link} from '@tanstack/react-router';
import {Users, BookMarked, Activity} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {failureText, online, RequestFailed} from '../../app/api.ts';
import {reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {Avatar, Button, Panel} from '../../ui/index.ts';
import {ContributionHeatmap} from '../activity/charts.tsx';
import {FeedPage} from '../home/Feed.tsx';
import {ResourceList} from '../settings/bits.tsx';
import {allPages} from '../settings/requests.ts';
import {useResource} from '../settings/resource.ts';

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
  return <div><Button size="sm" disabled={!connected || !res.fresh || busy} onClick={() => { void change(); }}>{res.value ? 'Unfollow' : 'Follow'}</Button>{error && <p role="alert">{error}</p>}</div>;
});

interface Person {id: number; login: string; full_name: string; avatar_url: string}
export const People = observer(function People({owner, isOrg}: {owner: string; isOrg: boolean}) {
  const app = useApp();
  const [kind, setKind] = useState('followers');
  const path = isOrg ? `/orgs/${encodeURIComponent(owner)}/members` : `/users/${encodeURIComponent(owner)}/${kind}`;
  const res = useResource(`profile-people:${path}`, (signal) => allPages<Person>(app, path, signal));
  return <Panel label="People" title={isOrg ? 'People' : 'Followers and following'}>
    {!isOrg && <div className="flex gap-2 px-3 py-2"><Button size="sm" onClick={() => { setKind('followers'); }}>Followers</Button><Button size="sm" onClick={() => { setKind('following'); }}>Following</Button></div>}
    <ResourceList res={res} what="The people" empty={{icon: Users, title: 'No people to show', description: 'None that you can see.'}}>
      {(people) => people.map((p) => <Link key={p.id} to="/$owner" params={{owner: p.login}} className="flex items-center gap-3 px-3 py-2"><Avatar name={p.login} src={p.avatar_url}/><span>{p.full_name || p.login}</span><span className="text-fg-muted">{p.login}</span></Link>)}
    </ResourceList>
  </Panel>;
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
    {visible && <><Heatmap owner={owner}/><Popular owner={owner}/><Panel label="Recent activity" title="Recent activity"><FeedPage context="" login={owner} connected={connected} performedOnly/></Panel></>}
  </div>;
});

const Heatmap = observer(function Heatmap({owner}: {owner: string}) {
  const app = useApp();
  const res = useResource(`profile-heatmap:${owner}`, async (signal) => await online<{timestamp: number; contributions: number}[]>(app, {api: 'v1', path: `/users/${encodeURIComponent(owner)}/heatmap`, signal}) ?? []);
  return <Panel label="Contributions" title="Contributions"><ResourceList res={res} what="Contributions" empty={{icon: Activity, title: 'No contributions', description: 'No activity in the last year.'}}>{(rows) => <ContributionHeatmap rows={rows}/>}</ResourceList></Panel>;
});

const Popular = observer(function Popular({owner}: {owner: string}) {
  const app = useApp();
  const res = useResource(`profile-popular:${owner}`, async (signal) => {
    const rows = await allPages<{id: number; name: string; owner: {login: string}; stars_count: number; description: string}>(app, `/users/${encodeURIComponent(owner)}/repos`, signal);
    return rows.sort((a, b) => b.stars_count - a.stars_count).slice(0, 6);
  });
  return <Panel label="Popular repositories" title="Popular repositories"><ResourceList res={res} what="Repositories" empty={{icon: BookMarked, title: 'No repositories', description: 'None that you can see.'}}>{(rows) => rows.map((r) => <Link key={r.id} to="/$owner/$repo" params={{owner: r.owner.login, repo: r.name}} className="flex flex-col px-3 py-2"><span>{r.name} · {r.stars_count} stars</span><span className="text-sm text-fg-muted">{r.description}</span></Link>)}</ResourceList></Panel>;
});
