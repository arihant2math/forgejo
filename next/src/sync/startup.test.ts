// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The leader syncs while hydration still reads IndexedDB (review round 2):
// what is released, reset or dropped meanwhile must not come back from the
// reads, and a position must never be persisted without its records.

import 'fake-indexeddb/auto';
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb';
import {expect, test, vi} from 'vitest';
import {META, modelStore, openDatabase, readMeta, request} from '../data/idb.ts';
import {clientSchemas} from '../data/models.ts';
import {bucketOf} from '../data/pool.ts';
import {FakeWS, Server} from '../test/fakeSync.ts';
import {type Data, openData} from './data.ts';

async function put(db: IDBDatabase, store: string, values: unknown[]): Promise<void> {
  const tx = db.transaction(store, 'readwrite');
  for (const v of values) tx.objectStore(store).put(v);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('tx'));
    };
  });
}

/** Records as the persister writes them: one value per bucket. */
function buckets(g: string, recs: {id: number}[]): {g: string; b: number; r: unknown[]}[] {
  const byB = new Map<number, unknown[]>();
  for (const r of recs) {
    const b = bucketOf(g, r.id);
    let l = byB.get(b);
    if (!l) byB.set(b, l = []);
    l.push(r);
  }
  return [...byB].map(([b, r]) => ({g, b, r}));
}

const G = 'repo:5';

/** A database holding pinned repo:5 (50 issues, position 40), optionally a big store that slows phase 2. */
async function seed(factory: IDBFactory, extraMeta: {k: string; v: unknown}[] = [], filler = 0): Promise<void> {
  const db = await openDatabase(1, {factory});
  const issues = Array.from({length: 50}, (_, i) => ({id: i + 1, g: G, v: 40, d: {id: i + 1, repo_id: 5, title: 't', state: 'open', updated_at: '2026-01-01T00:00:00Z'}}));
  await put(db, modelStore('Issue'), buckets(G, issues));
  for (let i = 0; i < filler; i++) {
    await put(db, modelStore('Repository'), [{g: 'repo:999', b: i, r: Array.from({length: 500}, (_, j) => ({id: i * 500 + j + 1, g: 'repo:999', v: 30, d: {id: 1}}))}]);
  }
  await put(db, META, [
    {k: 'schemas', v: clientSchemas()}, {k: 'flushedSeq', v: 1},
    {k: `group:${G}`, v: {group: G, position: 40, units: [], watermark: 40, tier: 'summary', holders: ['pin']}},
    ...extraMeta,
  ]);
  db.close();
}

function open(factory: IDBFactory, server: Server): Promise<Data> {
  FakeWS.all = [];
  return openData({
    userId: 1, auth: {token: () => Promise.resolve('tok'), refresh: () => Promise.resolve('tok')}, endpoint: '/-/sync',
    // The filler Repository store slows phase 2; peeking at it would delay phase 1 (and the leader) as well.
    peekModels: [],
    env: {indexedDB: factory, IDBKeyRange, locks: null, BroadcastChannel: null, transport: {WebSocket: FakeWS as unknown as typeof WebSocket, fetch: server.fetch, base: 'http://x/'}},
  });
}

function offline(): Server {
  const server = new Server();
  server.boots.set(G, [{watermark: 0, status: 503, retryAfter: '100'}]);
  return server;
}

test('a group released before it was hydrated does not come back from hydration', async () => {
  const factory = new IDBFactory();
  await seed(factory);
  const d = await open(factory, offline());
  d.pin(G, false);
  await d.hydrated;
  // The release reaches the client once this tab leads (after phase 1 and its modules): wait for it, not a fixed time.
  await vi.waitFor(() => {
    expect(d.pool.model('Issue').size).toBe(0);
  });
  await d.close();
  const db = await openDatabase(1, {factory});
  expect(await request(db.transaction(modelStore('Issue')).objectStore(modelStore('Issue')).count())).toBe(0);
  db.close();
});

test('closing before hydration finished: a released group\'s state goes with its records', async () => {
  const factory = new IDBFactory();
  await seed(factory, [], 200);
  const d = await open(factory, offline());
  d.pin(G, false);
  await new Promise((r) => setTimeout(r, 100));
  await d.close();
  const db = await openDatabase(1, {factory});
  expect((await readMeta(db)).has(`group:${G}`)).toBe(false);
  expect(await request(db.transaction(modelStore('Issue')).objectStore(modelStore('Issue')).count())).toBe(0);
  db.close();
});

test('a model dropped at start (schema) does not come back from hydration', async () => {
  const factory = new IDBFactory();
  const db = await openDatabase(1, {factory});
  const meta: {k: string; v: unknown}[] = [{k: 'schemas', v: {...clientSchemas(), Label: 0}}, {k: 'serverSchemas', v: clientSchemas()}, {k: 'flushedSeq', v: 1}];
  const server = new Server();
  for (let r = 1; r <= 40; r++) {
    const g = `repo:${r}`;
    meta.push({k: `group:${g}`, v: {group: g, position: 50, units: [], watermark: 50, tier: 'summary', holders: ['workspace']}});
    await put(db, modelStore('Label'), buckets(g, Array.from({length: 200}, (_, i) => ({id: r * 1000 + i, g, v: 40, d: {id: r * 1000 + i, repo_id: r}}))));
    server.boots.set(g, [{watermark: 0, status: 503, retryAfter: '100'}]);
  }
  await put(db, META, meta);
  db.close();
  const d = await open(factory, server);
  await d.hydrated;
  await new Promise((r) => setTimeout(r, 100));
  expect(d.pool.model('Label').size).toBe(0);
  await d.close();
});
