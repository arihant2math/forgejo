// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import fc from 'fast-check';
import {describe, expect, test} from 'vitest';
import {Pool} from '../data/pool.ts';
import {HttpError, load, loadURL} from './bootstrap.ts';
import {ndjsonLines} from './ndjson.ts';

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const lines of ndjsonLines(stream(chunks))) out.push(...lines);
  return out;
}

test('NDJSON lines survive any chunking, multi-byte characters included', async () => {
  const lines = ['{"a":1}', '{"b":"ü€😀"}', '{"c":[1,2,3]}'];
  const text = lines.join('\n') + '\n';
  const bytes = new TextEncoder().encode(text);
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({min: 1, max: bytes.length}), {maxLength: 6}), async (cuts) => {
    const points = [...new Set(cuts)].sort((a, b) => a - b);
    const parts: Uint8Array[] = [];
    let prev = 0;
    for (const p of [...points, bytes.length]) {
      if (p > prev) parts.push(bytes.slice(prev, p));
      prev = p;
    }
    const s = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    });
    const out: string[] = [];
    for await (const ls of ndjsonLines(s)) out.push(...ls);
    expect(out).toEqual(lines);
  }));
  expect(await collect(['{"x":1}\n{"y"', ':2}'])).toEqual(['{"x":1}', '{"y":2}']);
});

function ndjson(objs: unknown[]): Response {
  return new Response(stream(objs.map((o) => JSON.stringify(o) + '\n')), {status: 200});
}

const header = {type: 'header', group: 'org:3', watermark: 10, units: [], tier: 'full', schemas: {}};

describe('load', () => {
  test('applies lines, embedded profiles and the replacement', async () => {
    const pool = new Pool();
    pool.put('Team', 9, 'org:3', 5, {id: 9} as never);
    const res = await load(pool, {
      endpoint: '/-/sync', token: 't', group: 'org:3', heldUnits: [],
      fetch: () => Promise.resolve(ndjson([
        header,
        {v: 10, g: 'org:3', m: 'Team', id: 1, op: 'U', d: {id: 1, org_id: 3}},
        {v: 10, g: 'org:3', m: 'Unknown', id: 1, op: 'U', d: {}},
        {v: 10, g: 'profile:4', m: 'User', id: 4, op: 'U', d: {id: 4, login: 'p'}},
        {type: 'end', count: 2, refs: ['profile:4']},
      ])),
    });
    expect(res).toMatchObject({count: 1, embedded: 1, dropped: 1, end: {refs: ['profile:4']}});
    expect([...pool.model('Team').all()].map((e) => e.id)).toEqual([1]);
    expect(pool.model('User').get(4)?.group).toBe('profile:4');
  });

  test('an incomplete response throws and replaces nothing', async () => {
    const pool = new Pool();
    pool.put('Team', 9, 'org:3', 5, {id: 9} as never);
    await expect(load(pool, {
      endpoint: '/-/sync', token: 't', group: 'org:3', heldUnits: [],
      fetch: () => Promise.resolve(ndjson([header, {v: 10, g: 'org:3', m: 'Team', id: 1, op: 'U', d: {id: 1}}])),
    })).rejects.toThrow(/incomplete/);
    expect(pool.model('Team').size).toBe(2);
  });

  test('errors carry the status and Retry-After', async () => {
    const err = await load(new Pool(), {
      endpoint: '/-/sync', token: 't', group: 'repo:1', heldUnits: undefined,
      fetch: () => Promise.resolve(new Response('{"message":"indexing"}', {status: 503, headers: {'Retry-After': '2'}})),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({status: 503, retryAfter: 2, message: 'indexing'});
  });

  test('stops applying once the group is released', async () => {
    const pool = new Pool();
    let live = true;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(header) + '\n'));
        live = false;
        await Promise.resolve();
        c.enqueue(new TextEncoder().encode(JSON.stringify({v: 10, g: 'org:3', m: 'Team', id: 1, op: 'U', d: {id: 1}}) + '\n'));
        c.close();
      },
    });
    await expect(load(pool, {
      endpoint: '/-/sync', token: 't', group: 'org:3', heldUnits: [], live: () => live,
      fetch: () => Promise.resolve(new Response(body, {status: 200})),
    })).rejects.toThrow(/released/);
    expect(pool.model('Team').size).toBe(0);
  });

  test('URLs', () => {
    expect(loadURL({endpoint: '/-/sync', token: '', group: 'repo:1', heldUnits: undefined, models: ['Label', 'Issue']})).toBe('/-/sync/bootstrap?group=repo%3A1&model=Label%2CIssue');
    expect(loadURL({endpoint: '/-/sync', token: '', group: 'repo:1', heldUnits: undefined, kind: 'load', closedBefore: '17.3', limit: 50})).toBe('/-/sync/load?group=repo%3A1&closedBefore=17.3&limit=50');
  });
});
