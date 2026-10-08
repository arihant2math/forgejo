// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The same exit scenarios driven through the Next app's own data layer
// (src/sync/data.ts: SyncClient, pool, IndexedDB persistence), unmodified,
// against the real server: the workspace is bootstrapped and goes live; a
// keyed write's echo resolves whenSynced with the entity in the pool; a
// second session resumes from the persisted positions and catches up with
// what changed while it was away; access given and taken away appears in
// and is purged from the pool.

import 'fake-indexeddb/auto';
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb';
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {type Data, openData} from '../src/sync/data.ts';
import {env} from './env.ts';
import {type Account, type Repo, api, createIssue, createRepo, createUser, request, syncId, unique} from './forgejo.ts';
import {FetchEventSource} from './sse.ts';

const opened: Data[] = [];
afterAll(async () => {
  for (const d of opened) await d.close();
});

async function open(who: Account, factory: IDBFactory, transport: 'ws' | 'sse' = 'ws'): Promise<Data> {
  const d = await openData({
    userId: who.id,
    auth: {token: () => Promise.resolve(who.token), refresh: () => Promise.resolve(who.token)},
    endpoint: `${env.url}/-/sync`, transport, persistStorage: false,
    env: {indexedDB: factory, IDBKeyRange, locks: null, BroadcastChannel: null, transport: {base: env.url, EventSource: FetchEventSource as unknown as typeof EventSource}},
  });
  opened.push(d);
  await d.hydrated;
  await vi.waitFor(() => {
    expect(d.status.connection).toBe('live');
  }, {timeout: 30_000});
  return d;
}

async function close(d: Data): Promise<void> {
  await d.close();
  opened.splice(opened.indexOf(d), 1);
}

const titles = (d: Data, repo: Repo) => [...d.pool.model('Issue').by('repo_id', repo.id)].map((e) => e.get('title')).sort();

describe.each<'ws' | 'sse'>(['ws', 'sse'])('the app\'s data layer over %s', (transport) => {
  let alice: Account;
  let bob: Account;
  let repo: Repo;
  let secret: Repo;

  beforeAll(async () => {
    alice = await createUser('alice');
    bob = await createUser('bob');
    repo = await createRepo(alice);
    secret = await createRepo(alice, {private: true});
    await createIssue(alice, repo, 'one');
    await createIssue(alice, secret, 'secret one');
  });

  test('bootstrap → live → echo → reconnect from the persisted positions', async () => {
    const factory = new IDBFactory();
    const d = await open(alice, factory, transport);
    await vi.waitFor(() => {
      expect(titles(d, repo)).toEqual(['one']);
    }, {timeout: 20_000});

    // A keyed write: whenSynced(group, echo) resolves with the entity held.
    const res = await request('POST', `/api/v1/repos/${repo.full}/issues`, {token: alice.token, key: unique('key'), body: {title: 'two'}});
    const created = await res.json() as {id: number};
    await d.whenSynced(repo.group, syncId(res) ?? 0);
    expect(d.pool.model('Issue').get(created.id)?.get('title')).toBe('two');
    await close(d);

    // Away: changes happen. A new session hydrates what was persisted, then
    // resumes each group from its position.
    await api('PATCH', `/repos/${repo.full}/issues/1`, {token: alice.token, body: {title: 'one (edited)'}});
    await createIssue(alice, repo, 'three');
    const again = await open(alice, factory, transport);
    await vi.waitFor(() => {
      expect(titles(again, repo)).toEqual(['one (edited)', 'three', 'two']);
    }, {timeout: 20_000});
    await close(again);
  });

  test('access given appears in the pool; access taken is purged (revoked)', async () => {
    const d = await open(bob, new IDBFactory(), transport);
    expect(titles(d, secret)).toEqual([]);
    const revoked: string[] = [];
    d.on('revoked', (e) => revoked.push(e.group));

    await api('PUT', `/repos/${secret.full}/collaborators/${bob.login}`, {token: alice.token, body: {permission: 'read'}});
    // grants → workspace → bootstrap → subscription.
    await vi.waitFor(() => {
      expect(titles(d, secret)).toEqual(['secret one']);
    }, {timeout: 30_000});

    await api('DELETE', `/repos/${secret.full}/collaborators/${bob.login}`, {token: alice.token});
    await vi.waitFor(() => {
      expect(revoked).toContain(secret.group);
    }, {timeout: 30_000});
    expect(titles(d, secret)).toEqual([]);
    expect(d.pool.model('Repository').get(secret.id)).toBeUndefined();
    await close(d);
  });
});
