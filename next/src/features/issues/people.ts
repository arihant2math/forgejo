// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Who can be assigned to (or asked to review) a repository's issues: what
// the pool knows (candidates.ts: collaborators, members of the teams that
// have the repository) and, online, API v1's answer (`/assignees`), which
// also knows the members of teams the viewer is not in — the pool only
// carries those of the viewer's own teams (sync scope). The answer is kept
// for the session (in memory).

import {observable, runInAction} from 'mobx';
import {online} from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import type {Pool} from '../../data/pool.ts';
import {assigneeCandidates} from './candidates.ts';

export interface Person {
  id: number;
  login: string;
  name: string;
  avatar: string | undefined;
}

const remote = observable.map<number, Person[]>({}, {deep: false});
const asked = new Set<number>();

/** Asks API v1 for a repository's assignees once per session (online; errors are ignored and asked again later). */
export function loadPeople(app: App, repoId: number): void {
  const r = app.session?.data.pool.model('Repository').get(repoId)?.data;
  if (!r || asked.has(repoId) || !navigator.onLine) return;
  asked.add(repoId);
  online<{id: number; login: string; full_name: string; avatar_url: string}[]>(app, {
    api: 'v1', path: `/repos/${encodeURIComponent(r.owner_name)}/${encodeURIComponent(r.name)}/assignees`,
  }).then((users) => {
    runInAction(() => {
      remote.set(repoId, (users ?? []).map((u) => ({id: u.id, login: u.login, name: u.full_name || u.login, avatar: u.avatar_url || undefined})));
    });
  }, () => {
    asked.delete(repoId);
  });
}

/** The people of a repository (observes the pool and the API answer): the viewer first, then by login. */
export function repoPeople(pool: Pool, repoId: number, me: number, extra: Iterable<number> = []): Person[] {
  const out = new Map<number, Person>();
  for (const p of remote.get(repoId) ?? []) out.set(p.id, p);
  const users = pool.model('User');
  for (const id of [...assigneeCandidates(pool, repoId, me), ...extra]) {
    if (out.has(id)) continue;
    const u = users.get(id)?.data;
    if (u) out.set(id, {id, login: u.login, name: u.full_name || u.login, avatar: u.avatar_url || undefined});
  }
  return [...out.values()].sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.login.localeCompare(b.login)));
}
