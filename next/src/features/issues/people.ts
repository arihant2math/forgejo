// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The pool contains only the viewer's team memberships. API v1 supplies other assignees;
// cache its answer in memory for this session.

import {apiRepoPath} from '../../app/paths.ts';
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

/** Show the login to disambiguate namesakes; omit it when it duplicates the display name. */
export function personLogin(p: {login: string; name: string}): string | undefined {
  return p.login && p.login !== p.name ? p.login : undefined;
}

const remote = observable.map<number, Person[]>({}, {deep: false});
const asked = new Set<number>();

/** Cache successful assignee queries for the session; retry errors on later calls. */
export function loadPeople(app: App, repoId: number): void {
  const r = app.session?.data.pool.model('Repository').get(repoId)?.data;
  if (!r || asked.has(repoId) || !navigator.onLine) return;
  asked.add(repoId);
  online<{id: number; login: string; full_name: string; avatar_url: string}[]>(app, {
    api: 'v1', path: `${apiRepoPath(r.owner_name, r.name)}/assignees`,
  }).then((users) => {
    runInAction(() => {
      remote.set(repoId, (users ?? []).map((u) => ({id: u.id, login: u.login, name: u.full_name || u.login, avatar: u.avatar_url || undefined})));
    });
  }, () => {
    asked.delete(repoId);
  });
}

/** Order candidates with the viewer first, then by login. */
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
