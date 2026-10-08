// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import 'fake-indexeddb/auto';
import fc from 'fast-check';
import {IDBFactory} from 'fake-indexeddb';
import {describe, expect, test} from 'vitest';
import type {Issue} from '../protocol/types.gen.ts';
import {Hydrator} from './hydrate.ts';
import {BLOBS, DRAFTS, IDB_VERSION, INTENTS, type Layout, layout, META, modelStore, openDatabase, readMeta, request} from './idb.ts';
import {MetaCache} from './meta.ts';
import {CHUNK_VALUES, type Commit, Persister} from './persist.ts';
import {bucketOf, Pool} from './pool.ts';

function issue(id: number, repo: number, title: string): Issue {
  return {
    id, repo_id: repo, number: id, poster_id: 1, original_author: '', original_author_id: 0, title, content_version: 0,
    milestone_id: 0, priority: 0, state: 'open', is_pull: false, comments: 0, ref: '', pin_order: 0, is_locked: false,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
}

async function all<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return request(db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>);
}

async function putRaw(db: IDBDatabase, store: string, values: unknown[]): Promise<void> {
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

/** Records as bucket values (what the persister writes). */
function buckets(recs: {id: number; g: string; v: number; d: unknown}[]): {g: string; b: number; r: unknown[]}[] {
  const m = new Map<string, {g: string; b: number; r: unknown[]}>();
  for (const r of recs) {
    const k = `${r.g}#${bucketOf(r.g, r.id)}`;
    let v = m.get(k);
    if (!v) m.set(k, v = {g: r.g, b: bucketOf(r.g, r.id), r: []});
    v.r.push(r);
  }
  return [...m.values()];
}

function hydrateInto(db: IDBDatabase, pool: Pool): Hydrator {
  return new Hydrator(db, (m, recs) => {
    pool.batch(() => pool.load(m, recs));
  });
}

describe('schema', () => {
  test('the layout: a store per model keyed by [group, bucket], plus meta, intents, drafts, blobs', async () => {
    const db = await openDatabase(1, {factory: new IDBFactory()});
    const names = [...db.objectStoreNames];
    expect(names).toEqual(expect.arrayContaining([META, INTENTS, DRAFTS, BLOBS, modelStore('Issue'), modelStore('Comment')]));
    expect(names.filter((n) => n.startsWith('m:'))).toHaveLength(40);
    const store = db.transaction(modelStore('Issue'), 'readonly').objectStore(modelStore('Issue'));
    expect(store.keyPath).toEqual(['g', 'b']);
    expect([...store.indexNames]).toEqual([]);
    db.close();
  });

  test('an upgrade drops a changed model store, never intents or drafts', async () => {
    const factory = new IDBFactory();
    const db1 = await openDatabase(7, {factory});
    await putRaw(db1, INTENTS, [{kind: 'issue.addLabel', key: 'k1'}, {kind: 'issue.editBody', key: 'k2'}]);
    await putRaw(db1, DRAFTS, [{key: 'issue:1/body', text: 'unsent'}]);
    await putRaw(db1, BLOBS, [{sha: 'abc', atime: 1}]);
    await putRaw(db1, modelStore('Issue'), [{g: 'repo:1', b: 1, r: [{id: 1, g: 'repo:1', v: 1, d: issue(1, 1, 'a')}]}]);
    await putRaw(db1, modelStore('Label'), [{g: 'repo:1', b: 1, r: [{id: 1, g: 'repo:1', v: 1, d: {id: 1}}]}]);
    db1.close();

    // Next build: Issue gets another index, intents get an index, a model store is gone.
    const next: Layout = layout();
    const issueLayout = next[modelStore('Issue')];
    if (!issueLayout) throw new Error('no Issue store');
    next[modelStore('Issue')] = {...issueLayout, indexes: {...issueLayout.indexes, state: 'r.d.state'}};
    next[INTENTS] = {keyPath: 'seq', autoIncrement: true, indexes: {key: 'key'}};
    Reflect.deleteProperty(next, modelStore('Star'));
    const db2 = await openDatabase(7, {factory, layout: next, version: IDB_VERSION + 1});
    expect(await all(db2, modelStore('Issue'))).toEqual([]);
    expect(await all(db2, modelStore('Label'))).toHaveLength(1);
    expect(await all(db2, INTENTS)).toEqual([{kind: 'issue.addLabel', key: 'k1', seq: 1}, {kind: 'issue.editBody', key: 'k2', seq: 2}]);
    expect(await all(db2, DRAFTS)).toEqual([{key: 'issue:1/body', text: 'unsent'}]);
    expect(await all(db2, BLOBS)).toHaveLength(1);
    expect([...db2.objectStoreNames]).not.toContain(modelStore('Star'));
    expect((await readMeta(db2)).get('droppedModels')).toEqual(['Issue']);
    expect([...db2.transaction(INTENTS, 'readonly').objectStore(INTENTS).indexNames]).toEqual(['key']);
    db2.close();
  });

  test('a database of the version-1 layout (id mod 512 buckets) gets new model stores, keeps the rest', async () => {
    const factory = new IDBFactory();
    const db1 = await openDatabase(9, {factory, version: 1});
    await putRaw(db1, modelStore('Label'), [{g: 'repo:1', b: 300, r: [{id: 300, g: 'repo:1', v: 1, d: {id: 300}}]}]);
    await putRaw(db1, DRAFTS, [{key: 'd', text: 'x'}]);
    db1.close();
    const db2 = await openDatabase(9, {factory});
    expect(await all(db2, modelStore('Label'))).toEqual([]);
    expect(await all(db2, DRAFTS)).toHaveLength(1);
    expect(((await readMeta(db2)).get('droppedModels') as string[]).length).toBe(40);
    db2.close();
  });

  test('a layout that forgets intents or drafts does not delete them', async () => {
    const factory = new IDBFactory();
    const db1 = await openDatabase(8, {factory});
    await putRaw(db1, DRAFTS, [{key: 'd', text: 'x'}]);
    db1.close();
    const next = layout();
    Reflect.deleteProperty(next, DRAFTS);
    const db2 = await openDatabase(8, {factory, layout: next, version: IDB_VERSION + 1});
    expect(await all(db2, DRAFTS)).toHaveLength(1);
    db2.close();
  });
});

describe('persistence', () => {
  test('flush then hydrate gives the same pool (any sequence of changes and flushes)', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        op: fc.constantFrom('put', 'del', 'evict', 'purge', 'flush'),
        id: fc.integer({min: 1, max: 8}),
        g: fc.constantFrom('repo:1', 'repo:2'),
        v: fc.integer({min: 1, max: 30}),
      }), {maxLength: 40}),
      async (ops) => {
        const db = await openDatabase(1, {factory: new IDBFactory()});
        const pool = new Pool();
        const meta = new MetaCache();
        const p = new Persister(db, pool, meta);
        for (const o of ops) {
          if (o.op === 'flush') {
            await p.flush();
            continue;
          }
          pool.batch(() => {
            if (o.op === 'put') pool.put('Issue', o.id, o.g, o.v, issue(o.id, Number(o.g.slice(5)), `t${o.v}`));
            else if (o.op === 'del') pool.del('Issue', o.id, o.g, o.v);
            else if (o.op === 'evict') pool.evict('Issue', o.id, o.g, o.v);
            else pool.purgeGroup(o.g);
          });
        }
        meta.set('group:repo:1', {group: 'repo:1', position: 5, holders: []});
        await p.flush();
        const fresh = new Pool();
        await hydrateInto(db, fresh).rest();
        const view = (x: Pool) => [...x.model('Issue').all()].map((e) => [e.id, e._g, e._v, e._d.title]).sort();
        expect(view(fresh)).toEqual(view(pool));
        expect((await readMeta(db)).get('group:repo:1')).toEqual({group: 'repo:1', position: 5, holders: []});
        db.close();
      },
    ), {numRuns: 60});
  });

  test('large flushes are chunked, meta and the sequence go last', async () => {
    const db = await openDatabase(1, {factory: new IDBFactory()});
    const pool = new Pool();
    const meta = new MetaCache();
    const commits: Commit[] = [];
    const p = new Persister(db, pool, meta, {onCommit: (c) => commits.push(c)});
    // A repository has 32 buckets: 12 800 issues = 32 buckets of 400; CHUNK (5000) = 12 buckets per transaction.
    const n = 32 * 400;
    pool.batch(() => {
      for (let i = 1; i <= n; i++) pool.put('Issue', i, 'repo:1', i, issue(i, 1, 't'));
    });
    meta.set('x', 1);
    await p.flush();
    expect(commits.map((c) => [c.seq, c.last, c.buckets.length, c.buckets.reduce((s, w) => s + w.r.length, 0)])).toEqual([
      [1, false, 12, 4800], [1, false, 12, 4800], [1, true, 8, 3200],
    ]);
    expect(p.flushedSeq).toBe(1);
    const m = await readMeta(db);
    expect(m.get('flushedSeq')).toBe(1);
    expect(m.get('x')).toBe(1);
    pool.batch(() => pool.del('Issue', 1, 'repo:1', 100_000));
    await p.flush();
    const last = commits.at(-1);
    expect(last).toMatchObject({seq: 2, last: true});
    expect(last?.buckets.map((w) => [w.g, w.b, w.r.length])).toEqual([['repo:1', 1, 399]]);
    const values = await all<{r: unknown[]}>(db, modelStore('Issue'));
    expect(values).toHaveLength(32);
    expect(values.reduce((s, v) => s + v.r.length, 0)).toBe(n - 1);
    // An emptied bucket is deleted.
    pool.batch(() => {
      for (let i = 2; i <= n; i += 32) pool.del('Issue', i, 'repo:1', 100_000);
    });
    await p.flush();
    expect(await all(db, modelStore('Issue'))).toHaveLength(31);
    expect(commits.at(-1)?.buckets).toEqual([{m: 'Issue', g: 'repo:1', b: 2, r: []}]);
    db.close();
  });

  test('many small buckets: at most CHUNK_VALUES values per transaction', async () => {
    const db = await openDatabase(1, {factory: new IDBFactory()});
    const pool = new Pool();
    const commits: Commit[] = [];
    const p = new Persister(db, pool, new MetaCache(), {onCommit: (c) => commits.push(c)});
    pool.batch(() => {
      for (let i = 1; i <= CHUNK_VALUES + 100; i++) pool.put('Comment', i, `issue:${i}`, 1, {id: i, issue_id: i} as never);
    });
    await p.flush();
    expect(commits.map((c) => c.buckets.length)).toEqual([CHUNK_VALUES, 100]);
    db.close();
  });

  test('deferred groups are written later, with their positions; dropped groups are deleted first', async () => {
    const db = await openDatabase(1, {factory: new IDBFactory()});
    const pool = new Pool();
    const meta = new MetaCache();
    const deferred = new Set(['repo:2']);
    const commits: Commit[] = [];
    const p = new Persister(db, pool, meta, {defer: (g) => deferred.has(g), onCommit: (c) => commits.push(c)});
    pool.batch(() => {
      pool.put('Issue', 1, 'repo:1', 5, issue(1, 1, 'a'));
      pool.put('Issue', 2, 'repo:2', 5, issue(2, 2, 'b'));
    });
    meta.set('group:repo:1', {group: 'repo:1', position: 5, holders: []});
    meta.set('group:repo:2', {group: 'repo:2', position: 5, holders: []});
    await p.flush();
    const ids = async () => (await all<{r: {id: number}[]}>(db, modelStore('Issue'))).flatMap((v) => v.r.map((r) => r.id)).sort();
    expect(await ids()).toEqual([1]);
    expect((await readMeta(db)).has('group:repo:2')).toBe(false);
    deferred.clear();
    await p.flush();
    expect(await ids()).toEqual([1, 2]);
    expect((await readMeta(db)).get('group:repo:2')).toMatchObject({position: 5});
    // A dropped group: every bucket goes, also records the pool never had.
    await putRaw(db, modelStore('Issue'), [{g: 'repo:1', b: 7, r: [{id: 7, g: 'repo:1', v: 1, d: issue(7, 1, 'never hydrated')}]}]);
    p.dropGroups(['repo:1']);
    await p.flush();
    expect(await ids()).toEqual([2]);
    expect(commits.at(-1)).toMatchObject({dropped: ['repo:1']});
    p.close();
    db.close();
  });

  test('a failed flush keeps everything dirty and retries', async () => {
    const db = await openDatabase(1, {factory: new IDBFactory()});
    const pool = new Pool();
    const meta = new MetaCache();
    const errors: unknown[] = [];
    const p = new Persister(db, pool, meta, {onError: (e) => errors.push(e)});
    pool.batch(() => pool.put('Issue', 1, 'repo:1', 1, issue(1, 1, 'a')));
    db.close();
    await p.flush();
    p.close();
    expect(errors).toHaveLength(1);
    expect(pool.dirtyCount).toBe(1);
  });

  test('clearModels empties a store before the next writes', async () => {
    const db = await openDatabase(1, {factory: new IDBFactory()});
    const pool = new Pool();
    const commits: Commit[] = [];
    const p = new Persister(db, pool, new MetaCache(), {onCommit: (c) => commits.push(c)});
    pool.batch(() => pool.put('Issue', 1, 'repo:1', 1, issue(1, 1, 'a')));
    await p.flush();
    pool.clearModel('Issue');
    p.clearModels(['Issue']);
    pool.batch(() => pool.put('Issue', 2, 'repo:1', 2, issue(2, 1, 'b')));
    await p.flush();
    expect((await all<{r: {id: number}[]}>(db, modelStore('Issue'))).flatMap((v) => v.r.map((r) => r.id))).toEqual([2]);
    expect(commits.map((c) => [c.seq, c.cleared])).toEqual([[1, []], [2, ['Issue']], [2, []]]);
    p.close();
    db.close();
  });
});

describe('hydration', () => {
  test('groups first, then the rest without reading them again', async () => {
    const db = await openDatabase(1, {factory: new IDBFactory()});
    await putRaw(db, modelStore('Issue'), buckets([
      {id: 1, g: 'repo:1', v: 1, d: issue(1, 1, 'a')},
      {id: 2, g: 'repo:2', v: 1, d: issue(2, 2, 'b')},
    ]));
    await putRaw(db, modelStore('User'), buckets([{id: 9, g: 'profiles:public', v: 1, d: {id: 9, login: 'u'}}]));
    await putRaw(db, META, [{k: 'flushedSeq', v: 4}]);
    const seen: [string, number[], number][] = [];
    const h = new Hydrator(db, (m, recs, seq) => seen.push([m, recs.map((r) => r.id), seq]));
    const first = await h.groups(['repo:1', 'profiles:public', 'bogus']);
    expect(first.records).toBe(2);
    expect(seen.sort()).toEqual([['Issue', [1], 4], ['User', [9], 4]]);
    seen.length = 0;
    h.eager = true;
    const rest = await h.rest();
    expect(rest.records).toBe(1);
    expect(seen).toEqual([['Issue', [2], 4]]);
    expect(h.complete).toBe(true);
    db.close();
  });

  test('chunks of a big store', async () => {
    const db = await openDatabase(1, {factory: new IDBFactory()});
    const n = 4500;
    await putRaw(db, modelStore('Issue'), buckets(Array.from({length: n}, (_, i) => ({id: i + 1, g: i % 3 ? 'repo:1' : 'repo:2', v: 1, d: issue(i + 1, i % 3 ? 1 : 2, 't')}))));
    const pool = new Pool();
    const h = hydrateInto(db, pool);
    h.eager = true;
    await h.rest();
    expect(pool.model('Issue').size).toBe(n);
    expect(pool.model('Issue').by('repo_id', 1).size + pool.model('Issue').by('repo_id', 2).size).toBe(n);
    db.close();
  });
});
