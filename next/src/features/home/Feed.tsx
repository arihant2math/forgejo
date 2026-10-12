// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {failureText, online} from '../../app/api.ts';
import {sitePath} from '../../app/config.ts';
import {useSiteLink} from '../../app/links.ts';
import {reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {repoOfGroup} from '../../data/models.ts';
import {BorderBox} from '../../components/BorderBox.tsx';
import {ListRow} from '../../components/ListRow.tsx';
import {Avatar, Heading, Select} from '@primer/react';
import {useSource} from '../code/hooks.ts';
import {AgoCell} from '../issues/cells.tsx';
import {usePool} from '../../app/store.ts';
import {feedDays, feedEntry, type FeedAction} from './feed.ts';
import {Button} from '@primer/react';
import {EmptyState} from '../../components/EmptyState.tsx';

interface Org {username: string}
interface SavedPage {at: string; page: number; keys: string[]; more: boolean}
const LIMIT = 30;

export default observer(function Feed() {
  const app = useApp();
  const session = useSession();
  const pool = usePool();
  const cache = useSource().cache;
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [context, setContext] = useState('');
  const connected = reach(session.data.status.connection) === 'online';
  const login = pool.model('User').get(session.userId)?.get('login');
  useEffect(() => {
    let active = true;
    const key = 'home-orgs:0';
    void cache.get<Org[]>(key).then((v) => { if (active && v) setOrgs(v); });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (!connected) return;
      void (async () => {
        const all: Org[] = [];
        for (let page = 1; active; page++) {
          const rows = await online<Org[]>(app, {api: 'v1', path: `/user/orgs?limit=50&page=${String(page)}`, signal: controller.signal}) ?? [];
          all.push(...rows);
          if (rows.length < 50) break;
        }
        if (active) { setOrgs(all); cache.put(key, all); }
      })().catch(() => { /* Cached organizations remain available when Forgejo cannot answer. */ });
    }, 100);
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [app, cache, connected]);
  return <BorderBox label="Activity" title="Activity" actions={
    <Select aria-label="Activity context" size="small" value={context} onChange={(event) => { setContext(event.target.value); }}>
      <Select.Option value="">You</Select.Option>
      {orgs.map((o) => <Select.Option key={o.username} value={o.username}>{o.username}</Select.Option>)}
    </Select>
  }>
    {login && <FeedPage key={context} context={context} login={login} connected={connected}/>}
  </BorderBox>;
});

export function FeedPage({context, login, connected, performedOnly = false}: {context: string; login: string; connected: boolean; performedOnly?: boolean}) {
  const app = useApp();
  const session = useSession();
  const cache = useSource().cache;
  const link = useSiteLink();
  const [actions, setActions] = useState<FeedAction[]>([]);
  const [saved, setSaved] = useState<SavedPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const key = `home-feed:0:${context || login}:${String(performedOnly)}`;

  useEffect(() => {
    const controller = new AbortController();
    let idle: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alive = () => !controller.signal.aborted;
    const load = async () => {
      setBusy(true);
      setError('');
      try {
        const hit = await cache.get<SavedPage>(key);
        if (!alive()) return;
        if (page === 1 && hit) {
          const rows = await cache.getMany<FeedAction>(hit.keys);
          if (!alive()) return;
          setActions(rows.filter((r): r is FeedAction => r !== undefined));
          setSaved(hit);
        }
        if (!connected) return;
        const path = context ? `/orgs/${encodeURIComponent(context)}/activities/feeds` : `/users/${encodeURIComponent(login)}/activities/feeds`;
        const rows = await online<FeedAction[]>(app, {api: 'v1', path: `${path}?only-performed-by=${String(performedOnly)}&page=${String(page)}&limit=${String(LIMIT)}`, signal: controller.signal}) ?? [];
        if (!alive()) return;
        // One entry per action, keyed by repository, so a revoked repository's actions are purged with its content.
        const entries = rows.map((r) => [`home-action:${String(r.repo.id)}:${String(r.id)}`, r] as const);
        const next = {at: new Date().toISOString(), page, more: rows.length === LIMIT, keys: entries.map(([k]) => k)};
        cache.putMany([...entries, [key, next]]);
        setSaved(next);
        setActions((old) => page === 1 ? rows : [...old, ...rows.filter((r) => !old.some((o) => o.id === r.id))]);
      } catch (err) {
        if (alive()) setError(failureText(err));
      } finally {
        if (alive()) { setBusy(false); setReady(true); }
      }
    };
    // Home's pool-backed sections paint before this online-only request starts.
    if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(() => { void load(); }, {timeout: 2000});
    else timer = setTimeout(() => { void load(); }, 100);
    return () => {
      controller.abort();
      if (idle !== undefined) cancelIdleCallback(idle);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [app, cache, connected, context, login, key, page, attempt, performedOnly]);

  useEffect(() => session.data.on('revoked', ({group}) => {
    const repo = repoOfGroup(group);
    if (repo === undefined) return;
    void cache.purgeRepo(repo);
    setActions((rows) => rows.filter((r) => r.repo.id !== repo));
  }), [session, cache]);

  return <div aria-busy={busy}>
    {saved && <p className="px-4 py-2 text-xs text-muted">{connected ? 'Last fetched' : 'Offline · last fetched'} <AgoCell at={saved.at}/></p>}
    {!connected && !saved && <p className="px-4 py-2 text-base text-muted">Activity loads when you are online.</p>}
    {error && <p role="alert" className="px-4 py-2 text-base text-muted">{error}</p>}
    {feedDays(actions).map(([day, rows]) => <div key={day}>
      <div className="border-y border-muted bg-muted px-4 py-2"><Heading as="h3" variant="small">{day}</Heading></div>
      {rows.map((a) => {
        const entry = feedEntry(a);
        return <ListRow key={a.id} {...link(sitePath(app.config, entry.path))}
          leading={a.act_user.avatar_url ? <Avatar alt={a.act_user.login} src={a.act_user.avatar_url} size={20}/> : null} trailing={<AgoCell at={a.created}/>}>{entry.text}</ListRow>;
      })}
    </div>)}
    {connected && ready && !busy && !error && !actions.length && <EmptyState title="No recent activity" description="Watch repositories or follow people to see their updates here." spacious={false}/>}
    {connected && <div className="flex items-center gap-2 px-4 py-2">
      <Button variant="invisible" size="small" type="button" disabled={busy} onClick={() => { setPage(1); setAttempt((n) => n + 1); }}>{busy ? 'Loading…' : error ? 'Retry' : 'Refresh'}</Button>
      {saved?.more && !error && <Button variant="invisible" size="small" type="button" disabled={busy} onClick={() => { setPage(saved.page + 1); }}>Load more</Button>}
    </div>}
  </div>;
}
