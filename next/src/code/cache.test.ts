// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';
import {expect, test} from 'vitest';
import {openDatabase} from '../data/idb.ts';
import {CodeCache} from './cache.ts';

const SHA = 'f'.repeat(40);

async function db(): Promise<IDBDatabase> {
  return openDatabase(1, {factory: new IDBFactory()});
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test('values survive the memory level (a new cache on the same database reads them back)', async () => {
  const d = await db();
  const a = new CodeCache(d, {budget: 1e9});
  a.put(`tree:3:${SHA}:`, {entries: [1, 2]});
  a.put(`hl:3:${SHA}:go`, {spans: Uint32Array.of(3, 1), starts: Uint32Array.of(0, 1)});
  expect(a.peek(`tree:3:${SHA}:`)).toEqual({entries: [1, 2]});
  await flush();
  const b = new CodeCache(d, {budget: 1e9});
  expect(await b.has(`tree:3:${SHA}:`)).toBe(true);
  expect(await b.has(`tree:4:${SHA}:`)).toBe(false);
  expect(b.peek(`tree:3:${SHA}:`)).toBeUndefined();
  expect(await b.get(`tree:3:${SHA}:`)).toEqual({entries: [1, 2]});
  const hl = await b.get<{spans: Uint32Array}>(`hl:3:${SHA}:go`);
  expect([...hl?.spans ?? []]).toEqual([3, 1]);
  expect(b.peek(`tree:3:${SHA}:`)).toEqual({entries: [1, 2]});
});

test('LRU eviction keeps the budget, oldest first; reads refresh an entry', async () => {
  const d = await db();
  let now = 1_000_000;
  const c = new CodeCache(d, {budget: 250, now: () => now});
  for (const k of ['a', 'b', 'c']) {
    c.put(`blob:1:${k}`, 'x'.repeat(50)); // 100 bytes each
    now += 100_000;
    await flush();
  }
  const fresh = new CodeCache(d, {budget: 250, now: () => now});
  await fresh.get('blob:1:a');
  await flush();
  expect(await fresh.evict()).toBe(1);
  const left = (await fresh.entries()).map((e) => e.key).sort();
  expect(left).toEqual(['blob:1:a', 'blob:1:c']);
  expect(await new CodeCache(d).get('blob:1:b')).toBeUndefined();
});

test('eviction scans the metadata again only once this tab\'s writes may exceed the budget', async () => {
  const d = await db();
  let now = 1_000_000;
  const c = new CodeCache(d, {budget: 1000, now: () => now});
  let scans = 0;
  const entries = c.entries.bind(c);
  c.entries = () => {
    scans++;
    return entries();
  };
  const write = async (k: string) => {
    c.put(`blob:1:${k}`, 'x'.repeat(100)); // 200 bytes
    now += 1000;
    await flush();
    await c.evict();
  };
  await write('a');
  expect(scans).toBe(1);
  for (const k of ['b', 'c', 'd']) await write(k);
  expect(scans).toBe(1);
  await write('e');
  await write('f');
  expect(scans).toBe(2);
  // Trimmed below the budget (900 B): the oldest two of six go.
  expect((await entries()).map((e) => e.key).sort()).toEqual(['blob:1:c', 'blob:1:d', 'blob:1:e', 'blob:1:f']);
  now += 10 * 60_000;
  await c.evict();
  expect(scans).toBe(3);
});

test('a revoked repository\'s content is purged, in memory and in IndexedDB', async () => {
  const d = await db();
  const c = new CodeCache(d, {budget: 1e9});
  c.put('blob:7:x', 'secret');
  c.put('blob:8:y', 'other');
  await flush();
  await c.purgeRepo(7);
  // In-flight answers must not restore revoked content.
  c.put('blob:7:late', 'late');
  c.remember('dhl:7:x', 'late');
  expect(c.peek('blob:7:late')).toBeUndefined();
  expect(c.peek('dhl:7:x')).toBeUndefined();
  expect(c.peek('blob:7:x')).toBeUndefined();
  expect(await new CodeCache(d).get('blob:7:x')).toBeUndefined();
  expect(await new CodeCache(d).get('blob:8:y')).toBe('other');
});

test('getMany and putMany: many values in one transaction each, revoked repositories skipped', async () => {
  const d = await db();
  const c = new CodeCache(d, {budget: 1e9});
  await c.purgeRepo(9);
  c.putMany([['home-action:5:1', {id: 1}], ['home-action:6:2', {id: 2}], ['home-action:9:3', {id: 3}]]);
  await flush();
  const fresh = new CodeCache(d, {budget: 1e9});
  const origin = d.transaction.bind(d);
  let opened = 0;
  d.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
    opened++;
    return origin(...args);
  }) as IDBDatabase['transaction'];
  expect(await fresh.getMany(['home-action:5:1', 'home-action:6:2', 'home-action:9:3', 'home-action:5:4'])).toEqual([{id: 1}, {id: 2}, undefined, undefined]);
  expect(opened).toBe(2); // one read, one access-time update
  expect(await fresh.getMany(['home-action:5:1'])).toEqual([{id: 1}]);
  expect(opened).toBe(2);
});

test('a session has one cache: a revocation purges what code views and settings read, and later writes are refused', async () => {
  const {purgeRevoked, sessionCache} = await import('./cache.ts');
  const d = await db();
  const c = sessionCache(d);
  expect(sessionCache(d)).toBe(c);
  c.put('blob:7:x', 'secret');
  c.put('settings:7:hooks', ['hook']);
  c.put('blob:8:y', 'other');
  await flush();
  await purgeRevoked(d, 'issue:7');
  expect(c.peek('blob:7:x')).toBe('secret');
  await purgeRevoked(d, 'repo:7');
  expect(c.peek('blob:7:x')).toBeUndefined();
  expect(c.peek('settings:7:hooks')).toBeUndefined();
  c.put('blob:7:late', 'late');
  expect(c.peek('blob:7:late')).toBeUndefined();
  expect(await new CodeCache(d).get('settings:7:hooks')).toBeUndefined();
  expect(c.peek('blob:8:y')).toBe('other');
  c.close();
  expect(sessionCache(d)).not.toBe(c);
});

test('once the cache is loaded, a revocation marks the repository before the shell’s handler returns', async () => {
  const {sessionCache} = await import('./cache.ts');
  const {purgeCached} = await import('./revocation.ts');
  const d = await db();
  const c = sessionCache(d);
  c.put('blob:9:x', 'secret');
  const purged = purgeCached(d, 'repo:9');
  expect(c.peek('blob:9:x')).toBeUndefined();
  c.put('blob:9:late', 'late');
  expect(c.peek('blob:9:late')).toBeUndefined();
  await purged;
  c.close();
});
