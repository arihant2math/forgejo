// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A signed-in session for component tests: a real pool and auth state, the
// rest of the data layer stubbed (no IndexedDB, no network).

import {observable} from 'mobx';
import {AuthSession} from '../auth/session.ts';
import type {EntityRecord} from '../data/entity.ts';
import type {ModelName, ModelTypes} from '../data/models.ts';
import {Pool} from '../data/pool.ts';
import type {Issue, Repository, User, Workspace} from '../protocol/types.gen.ts';
import type {SyncStatus} from '../sync/client.ts';
import type {Data} from '../sync/data.ts';
import type {Session} from '../app/store.ts';

export const T = '2026-10-01T00:00:00Z';

export function repo(id: number, owner: User, name: string, extra: Partial<Repository> = {}): Repository {
  return {
    id, owner_id: owner.id, owner_name: owner.login, name, full_name: `${owner.login}/${name}`, description: '', website: '',
    private: false, fork: false, parent_id: 0, template: false, mirror: false, archived: false, empty: false, default_branch: 'main',
    stars_count: 0, forks_count: 0, watchers_count: 0, topics: [], object_format_name: 'sha1', avatar_url: '', created_at: T, updated_at: T,
    ...extra,
  };
}

export function user(id: number, login: string, type = 'user'): User {
  return {id, login, full_name: '', avatar_url: '', type, visibility: 'public', description: '', website: '', location: '', pronouns: '', created_at: T};
}

export function issue(id: number, repoId: number, number: number, title: string, extra: Partial<Issue> = {}): Issue {
  return {
    id, repo_id: repoId, number, poster_id: 1, original_author: '', original_author_id: 0, title, content_version: 0, milestone_id: 0,
    priority: 0, state: 'open', is_pull: false, comments: 0, ref: '', pin_order: 0, is_locked: false, created_at: T, updated_at: T, ...extra,
  };
}

export interface FakeData extends Data {
  held: Map<string, number>;
  intents: number;
  put<M extends ModelName>(m: M, g: string, d: ModelTypes[M] & {id: number}): void;
}

let version = 1;

export function fakeSession(opts: {userId?: number; workspace?: Workspace} = {}): Session & {data: FakeData} {
  const userId = opts.userId ?? 1;
  const pool = new Pool();
  const status: SyncStatus = observable({connection: 'live', transport: 'ws', loading: 0, groups: 0, serverSyncId: 0, lastError: undefined}, {}, {deep: false});
  const held = new Map<string, number>();
  const data = {
    userId, pool, status, role: observable({leader: true}),
    firstRoute: Promise.resolve({records: 0, ms: 0}), hydrated: Promise.resolve({records: 0, ms: 0}),
    workspace: observable({current: opts.workspace}, {}, {deep: false}),
    held,
    intents: 0,
    hydrate: () => Promise.resolve(),
    countIntents(this: {intents: number}) {
      return Promise.resolve(this.intents);
    },
    peek: () => new Map(),
    hold(g: string) {
      held.set(g, (held.get(g) ?? 0) + 1);
    },
    release(g: string) {
      const n = (held.get(g) ?? 0) - 1;
      if (n > 0) held.set(g, n);
      else held.delete(g);
    },
    pin: () => undefined,
    barrier: () => Promise.resolve(0),
    loadClosedPage: () => Promise.resolve({next: undefined, count: 0}),
    on: () => () => undefined,
    close: () => Promise.resolve(),
    put<M extends ModelName>(m: M, g: string, d: ModelTypes[M] & {id: number}) {
      const rec = {id: d.id, g, v: ++version, d} as EntityRecord<M>;
      pool.batch(() => pool.load(m, [rec]));
    },
  } as unknown as FakeData;
  const auth = new AuthSession(null, userId, {BroadcastChannel: null, locks: null});
  return {userId, auth, data};
}
