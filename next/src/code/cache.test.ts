// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';
import {expect, test} from 'vitest';
import {openDatabase} from '../data/idb.ts';
import {compact, highlight, SYN} from '../workers/highlight.ts';
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
  // `has` answers from the metadata record and reads nothing into memory (prefetch checks without churning it).
  expect(await b.has(`tree:3:${SHA}:`)).toBe(true);
  expect(await b.has(`tree:4:${SHA}:`)).toBe(false);
  expect(b.peek(`tree:3:${SHA}:`)).toBeUndefined();
  expect(await b.get(`tree:3:${SHA}:`)).toEqual({entries: [1, 2]});
  const hl = await b.get<{spans: Uint32Array}>(`hl:3:${SHA}:go`);
  expect([...hl?.spans ?? []]).toEqual([3, 1]);
  // A hit is in memory now.
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
  // Touch a (atime refreshed: written back after a minute).
  const fresh = new CodeCache(d, {budget: 250, now: () => now});
  await fresh.get('blob:1:a');
  await flush();
  expect(await fresh.evict()).toBe(1);
  const left = (await fresh.entries()).map((e) => e.key).sort();
  expect(left).toEqual(['blob:1:a', 'blob:1:c']);
  expect(await new CodeCache(d).get('blob:1:b')).toBeUndefined();
});

test('a revoked repository\'s content is purged, in memory and in IndexedDB', async () => {
  const d = await db();
  const c = new CodeCache(d, {budget: 1e9});
  c.put('blob:7:x', 'secret');
  c.put('blob:8:y', 'other');
  await flush();
  await c.purgeRepo(7);
  // An answer that was in flight when the repository was revoked is not put back.
  c.put('blob:7:late', 'late');
  c.remember('dhl:7:x', 'late');
  expect(c.peek('blob:7:late')).toBeUndefined();
  expect(c.peek('dhl:7:x')).toBeUndefined();
  expect(c.peek('blob:7:x')).toBeUndefined();
  expect(await new CodeCache(d).get('blob:7:x')).toBeUndefined();
  expect(await new CodeCache(d).get('blob:8:y')).toBe('other');
});

test('highlighting: classes from the CSS-variables theme, lengths add up to each line', async () => {
  const text = '{\n  "a": 1, // x\n  "b": "s"\n}\r';
  const h = await highlight(text, 'jsonc');
  if (!h) throw new Error('not highlighted');
  const lines = text.split('\n');
  expect(h.starts.length).toBe(lines.length + 1);
  const classes = new Set<number>();
  lines.forEach((l, i) => {
    let n = 0;
    for (let k = h.starts[i] ?? 0; k < (h.starts[i + 1] ?? 0); k++) {
      n += h.spans[2 * k] ?? 0;
      classes.add(h.spans[2 * k + 1] ?? 0);
    }
    expect(n, `line ${String(i)}`).toBe(l.length);
  });
  expect(classes.has(SYN.string)).toBe(true);
  expect(classes.has(SYN.comment)).toBe(true);
  // Plain for unknown grammars and huge inputs.
  expect(await highlight('x', undefined)).toBeNull();
});

test('compact merges neighbours of a class and fills what Shiki skipped', () => {
  const h = compact([[{content: 'ab', color: 'var(--shiki-token-keyword)'}, {content: 'c', color: 'var(--shiki-token-keyword)'}], []], 'abcd\nxyz');
  expect([...h.spans]).toEqual([3, SYN.keyword, 1, SYN.plain, 3, SYN.plain]);
  expect([...h.starts]).toEqual([0, 2, 3]);
});
