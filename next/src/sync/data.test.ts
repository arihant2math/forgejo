// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Two tabs of one user in one process: a fake Web Locks manager, Node's
// BroadcastChannel, one (fake) IndexedDB and the scripted server.

import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach, expect, test, vi} from 'vitest';
import {clientSchemas} from '../data/models.ts';
import {readSplash} from '../app/splash.ts';
import type {ServerMessage} from '../protocol/types.gen.ts';
import {FakeWS, issueChange, Server} from '../test/fakeSync.ts';
import {type Data, deleteUserData, openData} from './data.ts';

class FakeLocks {
  private held = false;
  private queue: (() => void)[] = [];

  request(_name: string, _opts: {signal?: AbortSignal}, cb: () => Promise<void> | undefined): Promise<void> {
    return new Promise((resolve) => {
      const run = () => {
        this.held = true;
        void Promise.resolve(cb()).then(() => {
          this.held = false;
          resolve();
          this.queue.shift()?.();
        });
      };
      if (this.held) this.queue.push(run);
      else run();
    });
  }
}

const opened: Data[] = [];
afterEach(async () => {
  for (const d of opened.splice(0)) await d.close();
});

function tab(server: Server, factory: IDBFactory, locks: FakeLocks, route?: string[]): Promise<Data> {
  return openData({
    userId: 1, auth: {token: () => Promise.resolve('tok'), refresh: () => Promise.resolve('tok')}, endpoint: '/-/sync', ...(route ? {route} : {}),
    env: {
      indexedDB: factory, locks: locks as unknown as LockManager, BroadcastChannel,
      transport: {WebSocket: FakeWS as unknown as typeof WebSocket, fetch: server.fetch, base: 'http://x/'},
    },
  }).then((d) => {
    opened.push(d);
    return d;
  });
}

function welcomeMsg(granted: {group: string; units: string[]}[] = []): ServerMessage {
  return {type: 'welcome', server_sync_id: 1, viewer_id: 1, granted, refused: [], grants: [], build_id: '', protocol: 1, schemas: clientSchemas()};
}

test('leader syncs and persists; a follower mirrors it, forwards holds and takes over', async () => {
  FakeWS.all = [];
  const server = new Server();
  server.workspace.groups = [{group: 'repo:1', units: ['issues'], reason: 'owner'}];
  server.boots.set('repo:1', [{watermark: 20, units: ['issues'], lines: [issueChange(1, 20, 'one'), issueChange(2, 20, 'two')]}]);
  server.boots.set('issue:2', [{watermark: 21, lines: [{v: 21, g: 'issue:2', m: 'Comment', id: 8, op: 'U', d: {id: 8, issue_id: 2}}]}]);
  const factory = new IDBFactory();
  const locks = new FakeLocks();

  const a = await tab(server, factory, locks);
  await vi.waitFor(() => {
    expect(a.role.leader).toBe(true);
  });
  expect(readSplash().user).toBe('1');
  const ws = FakeWS.latest();
  ws.open();
  await vi.waitFor(() => {
    expect(ws.last('hello')).toBeDefined();
  });
  ws.emit(welcomeMsg());
  await vi.waitFor(() => {
    expect(a.pool.model('Issue').size).toBe(2);
  });

  // A second tab: a follower that mirrors IndexedDB.
  const b = await tab(server, factory, locks);
  await b.hydrated;
  expect(b.role.leader).toBe(false);
  await vi.waitFor(() => {
    expect(b.pool.model('Issue').size).toBe(2);
  });
  await vi.waitFor(() => {
    expect(b.status.connection).toBe('catching_up');
  });

  // Live changes reach the follower after the leader's flush.
  ws.emit({type: 'subscribed', granted: [{group: 'repo:1', units: ['issues']}], refused: []});
  ws.emit({type: 'delta', to: 22, changes: [issueChange(1, 22, 'one!'), {v: 22, g: 'repo:1', m: 'Issue', id: 2, op: 'D'}]});
  await vi.waitFor(() => {
    expect(b.pool.model('Issue').get(1)?.get('title')).toBe('one!');
    expect(b.pool.model('Issue').get(2)).toBeUndefined();
  });

  // The follower's hold goes to the leader, which loads the group.
  server.boots.set('issue:1', [{watermark: 23, lines: [{v: 23, g: 'issue:1', m: 'Comment', id: 9, op: 'U', d: {id: 9, issue_id: 1}}]}]);
  b.hold('issue:1');
  await vi.waitFor(() => {
    expect(b.pool.model('Comment').get(9)).toBeDefined();
  });

  // The follower asks the leader for a barrier.
  const barrier = b.barrier();
  await vi.waitFor(() => {
    expect(ws.last('barrier')).toBeDefined();
  });
  ws.emit({type: 'barrier_ok', id: ws.last('barrier')?.id as string, sync_id: 30});
  await expect(barrier).resolves.toBe(30);

  // The leader goes away: the follower takes over and resumes from the persisted positions.
  const before = FakeWS.all.length;
  opened.splice(opened.indexOf(a), 1);
  await a.close();
  await vi.waitFor(() => {
    expect(b.role.leader).toBe(true);
  });
  await vi.waitFor(() => {
    expect(FakeWS.all.length).toBe(before + 1);
  });
  const ws2 = FakeWS.latest();
  ws2.open();
  await vi.waitFor(() => {
    expect(ws2.last('hello')).toBeDefined();
  });
  expect(ws2.last('hello')?.groups).toEqual(expect.arrayContaining([{group: 'repo:1', since: 22}, {group: 'issue:1', since: 23}]));
  expect(b.pool.model('Comment').get(9)).toBeDefined();
  expect(b.pool.model('Issue').size).toBe(1);
});

test('the route group is hydrated first; deleteUserData forgets the device', async () => {
  const server = new Server();
  const factory = new IDBFactory();
  const locks = new FakeLocks();
  const a = await tab(server, factory, locks, ['repo:1']);
  await a.firstRoute;
  await a.close();
  opened.length = 0;
  await deleteUserData(1, factory);
  expect(readSplash().user).toBeUndefined();
  const dbs = await factory.databases();
  expect(dbs).toEqual([]);
});
