// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The repository's Star and Watch buttons (its home's title row: repoPage.tsx RepoActions). Their counts are the
// Repository entity's (live, as the About sidebar's), shifted by the viewer's
// own change until the pool holds Forgejo's answer. Whether the viewer stars
// or watches comes from API v1 once; how they watch (issues, pull requests,
// releases) is their Watch row in the pool when it is there: API v1 sets only
// all or nothing, so a selection made in the classic UI (releases only) is
// shown as such and changed there.

import {useNavigate} from '@tanstack/react-router';
import {makeAutoObservable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect} from 'react';
import {failureText, online, onlineWrite, RequestFailed} from '../../app/api.ts';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {notify} from '../../app/notices.ts';
import {reach} from '../../app/online.ts';
import {useShortcut} from '../../app/shortcuts/index.ts';
import {type App, useApp, useSession} from '../../app/store.ts';
import {EyeIcon, StarIcon, PeopleIcon} from '@primer/octicons-react';
import {Button, ActionMenu, ActionList, CounterLabel, ButtonGroup} from '@primer/react';

/** What a Watch row selects (livesync's Watch entity). */
export interface WatchFlags {
  issues: boolean;
  pull_requests: boolean;
  releases: boolean;
}

/**
 * How the viewer watches the repository: nothing (participating and mentions only), everything, a part only (set in
 * the classic UI: releases only, say), or watching without the pool saying what (its Watch row is not synced yet).
 */
export type WatchLevel = 'none' | 'all' | 'custom' | 'unknown';

export function levelOf(w: WatchFlags): Exclude<WatchLevel, 'unknown'> {
  if (w.issues && w.pull_requests && w.releases) return 'all';
  return w.issues || w.pull_requests || w.releases ? 'custom' : 'none';
}

/** What a partial selection watches ("releases", "issues, releases"). */
export function watchedParts(w: WatchFlags): string {
  return [w.issues && 'issues', w.pull_requests && 'pull requests', w.releases && 'releases'].filter(Boolean).join(', ');
}

/** What the pool says about the repository and the viewer's watch (observable reads). */
export interface RepoSocialLive {
  stars(): number | undefined;
  watchers(): number | undefined;
  /** The viewer's Watch row for the repository, when the pool has it. */
  watch(): WatchFlags | undefined;
  /** Waits (bounded) until the pool holds a write's answer (its sync id). */
  synced?(syncId: number): Promise<void>;
}

type Count = 'stars' | 'watchers';

/** How long the viewer's own change is shown over the pool's counts at most, if its answer does not arrive. */
const CONFIRM_MS = 15_000;

export class RepoSocialState {
  starred = false;
  /** How the viewer watched by API v1 (or their last change): the level when the pool has no Watch row. */
  known: WatchLevel = 'none';
  ready = false;
  pending = false;
  loading = false;
  failed = false;
  /** The viewer's change over a count, until the pool holds it: the pool's count it was made on, and the change. */
  adjust: Record<Count, {from: number | undefined; delta: number; seq: number} | undefined> = {stars: undefined, watchers: undefined};
  /** The viewer's last watch choice, over a Watch row the pool may not have updated yet. */
  chosen: {level: 'all' | 'none'; seq: number} | undefined = undefined;
  private seq = 0;
  private readonly live: RepoSocialLive;
  constructor(live: RepoSocialLive) {
    this.live = live;
    makeAutoObservable<this, 'live' | 'seq'>(this, {live: false, seq: false});
  }
  get level(): WatchLevel {
    if (this.chosen) return this.chosen.level;
    const row = this.live.watch();
    return row ? levelOf(row) : this.known;
  }
  get watching(): boolean {
    return this.level !== 'none';
  }
  /** The partial selection, when the viewer watches only a part. */
  get parts(): string {
    const row = this.live.watch();
    return !this.chosen && row && levelOf(row) === 'custom' ? watchedParts(row) : '';
  }
  get stars(): number | undefined {
    return this.shown('stars', this.live.stars());
  }
  get watchers(): number | undefined {
    return this.shown('watchers', this.live.watchers());
  }
  /** The pool's count, with the viewer's change while the pool still has the count it was made on. */
  private shown(kind: Count, live: number | undefined): number | undefined {
    const a = this.adjust[kind];
    if (live === undefined) return undefined;
    return a && a.from === live ? live + a.delta : live;
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
      runInAction(() => { this.starred = starred; this.known = watching ? 'unknown' : 'none'; this.ready = true; });
    } catch (err) {
      runInAction(() => { this.failed = true; });
      notify(app, {tone: 'danger', title: failureText(err)});
    } finally { runInAction(() => { this.loading = false; }); }
  }
  /** Stars or unstars. */
  async toggleStar(app: App, owner: string, repo: string) {
    if (!this.ready || this.pending) return;
    const before = this.starred;
    await this.write(app, 'stars', before ? -1 : 1, {
      method: before ? 'DELETE' : 'PUT', path: `/user/starred/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    }, () => { this.starred = !before; }, () => { this.starred = before; });
  }
  /** Watches everything, or nothing (API v1 can set no part: releases only is the classic UI's). */
  async setWatch(app: App, owner: string, repo: string, level: 'all' | 'none') {
    if (!this.ready || this.pending || this.level === level) return;
    const before = {known: this.known, chosen: this.chosen};
    const delta = (level === 'none' ? 0 : 1) - (this.watching ? 1 : 0);
    const seq = this.seq + 1;
    await this.write(app, 'watchers', delta, {
      method: level === 'all' ? 'PUT' : 'DELETE', path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/subscription`,
    }, () => { this.known = level; this.chosen = {level, seq}; }, () => { this.known = before.known; this.chosen = before.chosen; });
  }
  private async write(app: App, kind: Count, delta: number, req: {method: 'PUT' | 'DELETE'; path: string}, apply: () => void, undo: () => void) {
    const seq = ++this.seq;
    const live = kind === 'stars' ? this.live.stars() : this.live.watchers();
    const previous = this.adjust[kind];
    // On top of a change of the viewer's own the pool does not hold yet.
    const carried = previous && previous.from === live ? previous.delta : 0;
    apply();
    if (delta !== 0 || carried !== 0) this.adjust[kind] = {from: live, delta: carried + delta, seq};
    this.pending = true;
    let syncId: number | undefined;
    try {
      ({syncId} = await onlineWrite(app, {api: 'v1', ...req}));
    } catch (err) {
      runInAction(() => {
        undo();
        if (this.adjust[kind]?.seq === seq) this.adjust[kind] = previous;
        this.pending = false;
      });
      notify(app, {tone: 'danger', title: failureText(err)});
      return;
    }
    runInAction(() => { this.pending = false; });
    // The pool's counts and Watch row take over once they hold the answer (or after a while if it does not come;
    // a count the pool changes meanwhile is shown at once).
    const timeout = new Promise((resolve) => setTimeout(resolve, CONFIRM_MS));
    await Promise.race([syncId !== undefined && this.live.synced ? this.live.synced(syncId).catch(() => undefined) : timeout, timeout]);
    runInAction(() => {
      if (this.adjust[kind]?.seq === seq) this.adjust[kind] = undefined;
      if (this.chosen?.seq === seq) this.chosen = undefined;
    });
  }
}

/** One state per repository and session (the pool it reads is the session's). */
const cache = new WeakMap<object, Map<number, RepoSocialState>>();
export const RepoSocial = observer(function RepoSocial({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  const app = useApp();
  const {data, userId} = useSession();
  let states = cache.get(data);
  if (!states) { states = new Map(); cache.set(data, states); }
  let state = states.get(repoId);
  if (!state) {
    const pool = data.pool;
    state = new RepoSocialState({
      stars: () => pool.model('Repository').get(repoId)?.get('stars_count'),
      watchers: () => pool.model('Repository').get(repoId)?.get('watchers_count'),
      watch: () => {
        for (const w of pool.model('Watch').by('repo_id', repoId)) if (w.get('user_id') === userId) return w.data;
        return undefined;
      },
      synced: async (syncId) => {
        const signal = AbortSignal.timeout(CONFIRM_MS);
        await Promise.all([`repo:${String(repoId)}`, `user:${String(userId)}`].map((g) => data.whenSynced(g, syncId, signal).catch(() => undefined)));
      },
    });
    states.set(repoId, state);
  }
  const s = state;
  const away = reach(data.status.connection) !== 'online';
  useEffect(() => { if (!away) void s.load(app, owner, repo); }, [app, s, owner, repo, away]);
  const disabled = away || !s.ready || s.pending;
  const star = () => { if (!disabled) void s.toggleStar(app, owner, repo); };
  const watch = (level: 'all' | 'none') => { if (!disabled) void s.setWatch(app, owner, repo, level); };
  useShortcut('repo.star', star, true, () => !disabled);
  useShortcut('repo.watch', () => { watch(s.watching ? 'none' : 'all'); }, true, () => !disabled);
  const level = s.level;
  const navigate = useNavigate();
  const mark = (on: boolean) => (on ? ' ✓' : '');
  return <div className="flex flex-wrap items-center gap-2">
    {away && <span className="text-sm text-muted">Available when online</span>}
    {s.failed && !away && <Button variant="invisible" size="small" type="button" disabled={s.loading} onClick={() => { void s.load(app, owner, repo); }}>Retry star/watch status</Button>}
    <ButtonGroup><Button leadingVisual={StarIcon} size="small" type="button" disabled={!away && (!s.ready || s.pending)} inactive={away} aria-pressed={s.starred} onClick={star}>
      {s.starred ? 'Unstar' : 'Star'}{s.stars !== undefined && <CounterLabel>{s.stars}</CounterLabel>}
    </Button></ButtonGroup>
    <ActionMenu><ActionMenu.Button size="small" leadingVisual={EyeIcon} disabled={!away && (!s.ready || s.pending)} inactive={away}>{s.watching ? 'Watching' : 'Watch'}{s.watchers !== undefined && <CounterLabel>{s.watchers}</CounterLabel>}</ActionMenu.Button><ActionMenu.Overlay><ActionList>
      <ActionList.Group selectionVariant="single"><ActionList.GroupHeading>Repository notifications</ActionList.GroupHeading>
      <ActionList.Item selected={level === 'none'} onSelect={() => { watch('none'); }}>Participating and mentions</ActionList.Item>
      <ActionList.Item selected={level === 'all'} onSelect={() => { watch('all'); }}>All activity</ActionList.Item>
      </ActionList.Group>
      {/* A part only (releases, say) is set in the classic UI's watch dialog: API v1 watches all or nothing. */}
      <ClassicMenuItem to={`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`}>{level === 'custom' ? `Custom: ${s.parts}${mark(true)}` : 'Custom (issues, pull requests or releases)…'}</ClassicMenuItem>
      <ActionList.Divider/>
      <ActionList.Item onSelect={() => void navigate({to: '/$owner/$repo/watchers', params: {owner, repo}})}><ActionList.LeadingVisual><PeopleIcon/></ActionList.LeadingVisual>Watchers</ActionList.Item>
      <ActionList.Divider/>
      <ActionList.Group><ActionList.GroupHeading>New releases are announced by email only (when this server sends mail), not in the Inbox.</ActionList.GroupHeading>
    </ActionList.Group></ActionList></ActionMenu.Overlay></ActionMenu>
  </div>;
});
