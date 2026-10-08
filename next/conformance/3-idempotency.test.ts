// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Idempotent API v1 writes (B7): a retried write with the same
// Idempotency-Key is answered from the stored response (one entity, the
// same bytes, the same sync id), concurrent duplicates run once, a key reused
// for another request is refused, and requests without a key are left
// alone. Their deltas reach a live session once, with v ≤ the echo.

import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import type {Issue} from '../src/protocol/types.gen.ts';
import {type Account, type Repo, api, createRepo, createUser, request, sleep, syncId, unique} from './forgejo.ts';
import {type Session, connect} from './sync.ts';

const open: Session[] = [];
afterAll(() => {
  for (const s of open) {
    s.close();
    expect(s.violations).toEqual([]);
  }
});

async function issuesTitled(who: Account, repo: Repo, title: string): Promise<number> {
  const list = await api<{title: string}[]>('GET', `/repos/${repo.full}/issues?state=all&type=issues&limit=50`, {token: who.token});
  return list.filter((i) => i.title === title).length;
}

describe('idempotency', () => {
  let alice: Account;
  let repo: Repo;
  let s: Session;

  beforeAll(async () => {
    alice = await createUser('alice');
    repo = await createRepo(alice);
    const c = await connect('ws', alice.token, [{group: repo.group}]);
    s = c.s;
    open.push(s);
    await s.next('caught_up');
  });

  test('the same key twice: one issue, the same response, one delta', async () => {
    const key = unique('key');
    const from = s.mark;
    const body = {title: 'once', body: 'only once'};
    const first = await request('POST', `/api/v1/repos/${repo.full}/issues`, {token: alice.token, key, body});
    const firstBody = await first.text();
    expect(first.status).toBe(201);
    expect(first.headers.get('X-Livesync-Idempotent-Replay')).toBeNull();
    const second = await request('POST', `/api/v1/repos/${repo.full}/issues`, {token: alice.token, key, body});
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Livesync-Idempotent-Replay')).toBe('true');
    expect(await second.text()).toBe(firstBody);
    expect(second.headers.get('Content-Type')).toBe(first.headers.get('Content-Type'));
    expect(syncId(second)).toBe(syncId(first));
    expect(await issuesTitled(alice, repo, 'once')).toBe(1);

    const id = (JSON.parse(firstBody) as {id: number}).id;
    const c = await s.change((x) => x.m === 'Issue' && x.id === id, {from});
    expect(c.v).toBeLessThanOrEqual(syncId(first) ?? 0);
    await s.barrier();
    expect(s.changes((x) => x.m === 'Issue' && (x.d as Issue | undefined)?.title === 'once', from)).toHaveLength(1);
  });

  test('a key reused for another request is refused (422)', async () => {
    const key = unique('key');
    expect((await request('POST', `/api/v1/repos/${repo.full}/labels`, {token: alice.token, key, body: {name: 'a', color: '#000000'}})).status).toBe(201);
    const other = await request('POST', `/api/v1/repos/${repo.full}/labels`, {token: alice.token, key, body: {name: 'b', color: '#000000'}});
    expect(other.status).toBe(422);
  });

  test('concurrent duplicates: one runs, the others wait (409 + Retry-After) or replay', async () => {
    const key = unique('key');
    const body = {title: 'raced'};
    const answers = await Promise.all(Array.from({length: 8}, () => request('POST', `/api/v1/repos/${repo.full}/issues`, {token: alice.token, key, body})));
    const ran = answers.filter((r) => r.status === 201 && r.headers.get('X-Livesync-Idempotent-Replay') === null);
    expect(ran).toHaveLength(1);
    for (const r of answers) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 409) expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
    }
    const created = await ran[0]?.json() as {id: number};
    // A waiting retry ends with the stored answer.
    let replay: Response;
    for (;;) {
      replay = await request('POST', `/api/v1/repos/${repo.full}/issues`, {token: alice.token, key, body});
      if (replay.status !== 409) break;
      await sleep(200);
    }
    expect(replay.status).toBe(201);
    expect((await replay.json() as {id: number}).id).toBe(created.id);
    expect(await issuesTitled(alice, repo, 'raced')).toBe(1);
  });

  test('a delete is replayed with its stored status and sync id', async () => {
    const label = await api<{id: number}>('POST', `/repos/${repo.full}/labels`, {token: alice.token, body: {name: 'to delete', color: '#ff0000'}});
    const key = unique('key');
    const from = s.mark;
    const del = await request('DELETE', `/api/v1/repos/${repo.full}/labels/${label.id}`, {token: alice.token, key});
    expect(del.status).toBe(204);
    const again = await request('DELETE', `/api/v1/repos/${repo.full}/labels/${label.id}`, {token: alice.token, key});
    expect(again.status).toBe(204);
    expect(again.headers.get('X-Livesync-Idempotent-Replay')).toBe('true');
    expect(syncId(again)).toBe(syncId(del));
    const c = await s.change((x) => x.m === 'Label' && x.id === label.id && x.op === 'D', {from});
    expect(c.v).toBeLessThanOrEqual(syncId(del) ?? 0);
  });

  test('without a key, or on a read, the layer stays out of the way', async () => {
    const plain = await request('POST', `/api/v1/repos/${repo.full}/issues`, {token: alice.token, body: {title: 'plain'}});
    expect(plain.status).toBe(201);
    expect(syncId(plain)).toBeUndefined();
    const read = await request('GET', `/api/v1/repos/${repo.full}`, {token: alice.token, key: unique('key')});
    expect(read.status).toBe(200);
    expect(syncId(read)).toBeUndefined();
    expect(read.headers.get('X-Livesync-Idempotent-Replay')).toBeNull();
    // A keyed write needs a token (the key is scoped to the user).
    const anon = await request('POST', `/api/v1/repos/${repo.full}/issues`, {key: unique('key'), body: {title: 'anonymous'}});
    expect(anon.status).toBe(401);
  });
});
