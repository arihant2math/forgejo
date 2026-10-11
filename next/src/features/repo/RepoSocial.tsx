// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Eye, Star} from 'lucide-react';
import {makeAutoObservable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';
import {failureText, online, RequestFailed} from '../../app/api.ts';
import {notify} from '../../app/notices.ts';
import {reach} from '../../app/online.ts';
import {useShortcut} from '../../app/shortcuts/index.ts';
import {type App, useApp, useSession} from '../../app/store.ts';
import {Badge, Button, Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger} from '../../ui/index.ts';

export class RepoSocialState {
  starred = false;
  watching = false;
  ready = false;
  pending = false;
  loading = false;
  failed = false;
  stars: number;
  watchers: number;
  constructor(stars: number, watchers: number) {
    this.stars = stars;
    this.watchers = watchers;
    makeAutoObservable(this);
  }
  async load(app: App, owner: string, repo: string) {
    if (this.ready || this.loading) return;
    this.loading = true;
    this.failed = false;
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const exists = async (path: string) => {
      try { await online(app, {api: 'v1', path}); return true; }
      catch (err) { if (err instanceof RequestFailed && err.status === 404) return false; throw err; }
    };
    try {
      const [starred, watching] = await Promise.all([
        exists(`/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`), exists(`${base}/subscription`),
      ]);
      runInAction(() => { this.starred = starred; this.watching = watching; this.ready = true; });
    } catch (err) {
      runInAction(() => { this.failed = true; });
      notify(app, {tone: 'danger', title: failureText(err)});
    } finally { runInAction(() => { this.loading = false; }); }
  }
  async toggle(app: App, owner: string, repo: string, kind: 'star' | 'watch') {
    if (!this.ready || this.pending) return;
    const field = kind === 'star' ? 'starred' : 'watching';
    const count = kind === 'star' ? 'stars' : 'watchers';
    const before = this[field];
    const delta = before ? -1 : 1;
    this[field] = !before;
    this[count] += delta;
    this.pending = true;
    try {
      await online(app, {api: 'v1', method: before ? 'DELETE' : 'PUT', path: kind === 'star' ?
        `/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` :
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/subscription`});
    } catch (err) {
      runInAction(() => { this[field] = before; this[count] -= delta; });
      notify(app, {tone: 'danger', title: failureText(err)});
    } finally { runInAction(() => { this.pending = false; }); }
  }
}

const cache = new WeakMap<App, Map<number, RepoSocialState>>();
export const RepoSocial = observer(function RepoSocial({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const {data} = useSession();
  const r = data.pool.model('Repository').get(repoId);
  let states = cache.get(app);
  if (!states) { states = new Map(); cache.set(app, states); }
  let state = states.get(repoId);
  if (!state) { state = new RepoSocialState(r?.get('stars_count') ?? 0, r?.get('watchers_count') ?? 0); states.set(repoId, state); }
  const s = state;
  const away = reach(data.status.connection) !== 'online';
  useEffect(() => { if (!away) void s.load(app, owner, repo); }, [app, s, owner, repo, away]);
  const disabled = away || !s.ready || s.pending;
  const toggle = (kind: 'star' | 'watch') => { if (!disabled) void s.toggle(app, owner, repo, kind); };
  useShortcut('repo.star', () => { toggle('star'); }, true, () => !disabled);
  useShortcut('repo.watch', () => { toggle('watch'); }, true, () => !disabled);
  return <div className="flex items-center gap-2" title={away ? 'Available when online' : undefined}>
    {s.failed && !away && <Button size="sm" variant="ghost" disabled={s.loading} onClick={() => { void s.load(app, owner, repo); }}>Retry star/watch status</Button>}
    <Button size="sm" variant="secondary" disabled={disabled} aria-pressed={s.starred} onClick={() => { toggle('star'); }}>
      <Icon icon={Star} size="sm"/>{s.starred ? 'Unstar' : 'Star'}<Badge>{s.stars}</Badge>
    </Button>
    <Menu><Button asChild size="sm" variant="secondary" disabled={disabled}><MenuTrigger>
      <Icon icon={Eye} size="sm"/>{s.watching ? 'Watching' : 'Watch'}<Badge>{s.watchers}</Badge>
    </MenuTrigger></Button><MenuContent>
      <MenuLabel>Repository notifications</MenuLabel>
      <MenuItem onSelect={() => { if (s.watching) toggle('watch'); }}>Participating and mentions{s.watching ? '' : ' ✓'}</MenuItem>
      <MenuItem onSelect={() => { if (!s.watching) toggle('watch'); }}>All activity{s.watching ? ' ✓' : ''}</MenuItem>
      <MenuLabel>Forgejo supports watching or not watching.</MenuLabel>
    </MenuContent></Menu>
  </div>;
});
