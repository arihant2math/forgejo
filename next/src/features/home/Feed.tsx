// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {failureText, online} from '../../app/api.ts';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {reach} from '../../app/online.ts';
import {useApp, useSession} from '../../app/store.ts';
import {Avatar, Button, ListRow, Panel, SectionHeading, Select} from '../../ui/index.ts';
import {useSource} from '../code/hooks.ts';
import {AgoCell, usePool} from '../issues/cells.tsx';
import {feedDays, feedEntry, type FeedAction} from './feed.ts';

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
  return <Panel label="Activity" title={<span className="text-fg">Activity</span>} actions={
    <Select aria-label="Activity context" size="sm" value={context} onValueChange={setContext}
      options={[{value: '', label: 'You'}, ...orgs.map((o) => ({value: o.username, label: o.username}))]}/>
  }>
    {login && <FeedPage key={context} context={context} login={login} connected={connected}/>}
  </Panel>;
});

function FeedPage({context, login, connected}: {context: string; login: string; connected: boolean}) {
  const app = useApp();
  const session = useSession();
  const cache = useSource().cache;
  const click = useLinkClick();
  const [actions, setActions] = useState<FeedAction[]>([]);
  const [saved, setSaved] = useState<SavedPage>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  const key = `home-feed:0:${context || login}`;

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
          const rows = await Promise.all(hit.keys.map((k) => cache.get<FeedAction>(k)));
          if (!alive()) return;
          setActions(rows.filter((r): r is FeedAction => r !== undefined));
          setSaved(hit);
        }
        if (!connected) return;
        const path = context ? `/orgs/${encodeURIComponent(context)}/activities/feeds` : `/users/${encodeURIComponent(login)}/activities/feeds`;
        const rows = await online<FeedAction[]>(app, {api: 'v1', path: `${path}?only-performed-by=false&page=${String(page)}&limit=${String(LIMIT)}`, signal: controller.signal}) ?? [];
        if (!alive()) return;
        const next = {at: new Date().toISOString(), page, more: rows.length === LIMIT, keys: rows.map((r) => `home-action:${String(r.repo.id)}:${String(r.id)}`)};
        rows.forEach((r) => { cache.put(`home-action:${String(r.repo.id)}:${String(r.id)}`, r); });
        cache.put(key, next);
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
  }, [app, cache, connected, context, login, key, page, attempt]);

  useEffect(() => session.data.on('revoked', ({group}) => {
    if (group.startsWith('repo:')) {
      const repo = Number(group.slice(5));
      void cache.purgeRepo(repo);
      setActions((rows) => rows.filter((r) => r.repo.id !== repo));
    }
  }), [session, cache]);

  return <div aria-busy={busy}>
    {saved && <p className="px-3 py-2 text-xs text-fg-subtle">{connected ? 'Last fetched' : 'Offline · last fetched'} <AgoCell at={saved.at}/></p>}
    {!connected && !saved && <p className="px-3 py-2 text-sm text-fg-muted">Activity loads when you are online.</p>}
    {error && <p role="alert" className="px-3 py-2 text-sm text-fg-muted">{error}</p>}
    {feedDays(actions).map(([day, rows]) => <div key={day}>
      <SectionHeading>{day}</SectionHeading>
      {rows.map((a) => {
        const entry = feedEntry(a);
        const href = hrefOf(app, entry.path);
        return <ListRow key={a.id} role={undefined} href={href} onClick={(e) => click(e, href)}
          leading={<Avatar name={a.act_user.login} src={a.act_user.avatar_url}/>} trailing={<AgoCell at={a.created}/>}>{entry.text}</ListRow>;
      })}
    </div>)}
    {connected && ready && !busy && !error && !actions.length && <p className="px-3 py-2 text-sm text-fg-muted">No recent activity. Watch repositories or follow people to see their updates here.</p>}
    {connected && <div className="px-3 py-2">
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPage(1); setAttempt((n) => n + 1); }}>{busy ? 'Loading…' : error ? 'Retry' : 'Refresh'}</Button>
      {saved?.more && !error && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPage(saved.page + 1); }}>Load more</Button>}
    </div>}
  </div>;
}
