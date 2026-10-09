// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The session protocol over both transports: hello → welcome, bootstrap →
// live, the sync-id echo of a write, barriers, reconnect from a cursor
// (replay then live, converging with a fresh bootstrap), and the
// bootstrap_required reasons a client can be sent.

import {beforeAll, describe, expect, test} from 'vitest';
import type {Issue, IssueBody, Label} from '../src/protocol/types.gen.ts';
import {canSQL, env} from './env.ts';
import {type Account, type Repo, api, createIssue, createRepo, createUser, keyed, request, syncId, unique} from './forgejo.ts';
import {Replica, load} from './replica.ts';
import {type Kind, Session, closedAfterAll, connect, expectConverged} from './sync.ts';
import {sql} from './sql.ts';

const open = closedAfterAll();

async function session(kind: Kind, who: Account, groups?: Parameters<typeof connect>[2]) {
  const r = await connect(kind, who.token, groups);
  open.push(r.s);
  return r;
}

describe.each<Kind>(['ws', 'sse'])('%s', (kind) => {
  let alice: Account;
  let repo: Repo;
  let first: {id: number; number: number};

  beforeAll(async () => {
    alice = await createUser('alice');
    repo = await createRepo(alice);
    first = await createIssue(alice, repo, 'first issue', 'hello');
  });

  test('an invalid token gets session_invalid and the session is closed', async () => {
    const s = await Session.open(kind);
    open.push(s);
    s.send({type: 'hello', token: 'not-a-token'});
    const m = await s.next('session_invalid');
    expect(m.message).not.toBe('');
    const closed = await s.whenClosed();
    if (kind === 'ws') expect(closed.code).toBe(1008);
  });

  test('anything before the hello is refused and the session is closed', async () => {
    const s = await Session.open(kind);
    open.push(s);
    s.send({type: 'ping', id: 'early'});
    expect((await s.next('error')).code).toBe('hello_required');
    await s.whenClosed();
    expect(s.messages.some((m) => m.type === 'pong')).toBe(false);
  });

  test('hello → welcome: viewer, implicit grants, own profile, schemas', async () => {
    const {welcome} = await session(kind, alice);
    expect(welcome.viewer_id).toBe(alice.id);
    expect(welcome.protocol).toBe(1);
    const grants = new Map(welcome.grants.map((g) => [g.group, g.units]));
    expect(grants.get(`user:${alice.id}`)).toEqual(['self']);
    expect(grants.get(repo.group)).toEqual(expect.arrayContaining(['code', 'issues', 'pulls']));
    expect(welcome.profile?.m).toBe('User');
    expect((welcome.profile?.d as {login: string}).login).toBe(alice.login);
    expect(welcome.schemas.Issue).toBeGreaterThan(0);
    expect(welcome.granted).toEqual([]);
  });

  test('bootstrap → subscribe from the watermark → live deltas; the write echo and barriers', async () => {
    const b = await load(alice.token, repo.group);
    expect(b.header).toMatchObject({type: 'header', group: repo.group, tier: 'summary'});
    expect(b.end.count).toBe(b.changes.filter((c) => c.g === repo.group).length);
    expect(b.changes.every((c) => c.v === b.header.watermark && c.op === 'U')).toBe(true);
    const issue = b.changes.find((c) => c.m === 'Issue' && c.id === first.id);
    expect((issue?.d as Issue).title).toBe('first issue');
    expect(b.changes.some((c) => c.m === 'Repository' && c.id === repo.id)).toBe(true);

    const {s} = await session(kind, alice);
    const sub = await s.subscribeCaughtUp([{group: repo.group, since: b.header.watermark}]);
    expect(sub.granted).toEqual([{group: repo.group, units: b.header.units}]);
    const replica = new Replica();
    replica.bootstrap(b);

    // A keyed API v1 write answers with the sync id echo; its delta arrives
    // live with v ≤ the echo, and the group's position reaches it.
    const from = s.mark;
    const res = await request('POST', `/api/v1/repos/${repo.full}/issues`, {token: alice.token, key: unique('k'), body: {title: 'live issue'}});
    expect(res.status).toBe(201);
    const created = await res.json() as {id: number};
    const echo = syncId(res);
    expect(echo).toBeGreaterThan(b.header.watermark);
    const c = await s.change((x) => x.m === 'Issue' && x.id === created.id, {from});
    expect(c.g).toBe(repo.group);
    expect(c.v).toBeLessThanOrEqual(echo ?? 0);
    expect(c.v).toBeGreaterThan(b.header.watermark);
    expect((c.d as Issue).title).toBe('live issue');
    for (const x of s.changes(() => true, from)) replica.apply(x);
    const ok = await s.barrier();
    expect(ok.sync_id).toBeGreaterThanOrEqual(echo ?? 0);
    expect(s.position(repo.group)).toBeGreaterThanOrEqual(echo ?? 0);

    // A write without the key is API v1's own answer: no echo.
    const plain = await request('PATCH', `/api/v1/repos/${repo.full}/issues/${first.number}`, {token: alice.token, body: {title: 'first issue (edited)'}});
    expect(plain.status).toBe(201);
    expect(syncId(plain)).toBeUndefined();
    const edited = await s.change((x) => x.m === 'Issue' && x.id === first.id && (x.d as Issue).title === 'first issue (edited)', {from});
    replica.apply(edited);

    // ping → pong with the server's position.
    s.send({type: 'ping', id: 'p1'});
    expect((await s.next('pong', (m) => m.id === 'p1')).sync_id).toBeGreaterThanOrEqual(edited.v);

    // The lazy tier of an issue: its body arrives through issue:{id}.
    const lazy = await load(alice.token, `issue:${first.id}`, {path: 'load'});
    expect(lazy.header.tier).toBe('full');
    expect((lazy.changes.find((x) => x.m === 'IssueBody' && x.id === first.id)?.d as IssueBody).body).toBe('hello');
  });

  test('reconnect from a cursor: the replay brings the newest states and the deletes, then live; converges', async () => {
    const b = await load(alice.token, repo.group);
    const replica = new Replica();
    replica.bootstrap(b);
    const one = await session(kind, alice);
    await one.s.subscribeCaughtUp([{group: repo.group, since: b.header.watermark}]);
    const label = await api<{id: number}>('POST', `/repos/${repo.full}/labels`, {token: alice.token, body: {name: 'kept', color: '#00aabb'}});
    await one.s.change((c) => c.m === 'Label' && c.id === label.id);
    await one.s.barrier();
    for (const c of one.s.changes()) if (c.g === repo.group) replica.apply(c);
    const cursor = one.s.position(repo.group) ?? 0;
    expect(cursor).toBeGreaterThan(b.header.watermark);
    one.s.close();

    // Offline: an issue is created, a label renamed three times, a label
    // created and deleted again (keyed writes: in the sync log when answered).
    const k = () => ({token: alice.token, key: unique('key')});
    const offline = await api<{id: number}>('POST', `/repos/${repo.full}/issues`, {...k(), body: {title: 'while away'}});
    for (const name of ['kept 1', 'kept 2', 'kept 3']) {
      await api('PATCH', `/repos/${repo.full}/labels/${label.id}`, {...k(), body: {name}});
    }
    const gone = await api<{id: number}>('POST', `/repos/${repo.full}/labels`, {...k(), body: {name: 'short-lived', color: '#112233'}});
    await api('DELETE', `/repos/${repo.full}/labels/${gone.id}`, k());
    // The server's sessions have seen all of it (a barrier of another
    // session), so the replay covers it all: one state per entity. (Had the
    // hub not caught up yet, the rest would follow live, as later changes.)
    const other = await session(kind, alice);
    await other.s.barrier();
    other.s.close();

    // Resume in the hello.
    const two = await session(kind, alice, [{group: repo.group, since: cursor}]);
    expect(two.welcome.granted.map((g) => g.group)).toEqual([repo.group]);
    await two.s.next('caught_up');
    const replay = two.s.changes((c) => c.g === repo.group);
    const of = (m: string, id: number) => replay.filter((c) => c.m === m && c.id === id);
    // Each entity at most once: its state now, not its history.
    expect(of('Label', label.id).map((c) => (c.d as Label).name)).toEqual(['kept 3']);
    expect(of('Issue', offline.id)).toHaveLength(1);
    expect(of('Label', gone.id).map((c) => c.op)).toEqual(['D']);
    expect(replay.every((c) => c.v > cursor)).toBe(true);
    for (const c of replay) replica.apply(c);

    // …then live.
    const from = two.s.mark;
    const after = await createIssue(alice, repo, 'after resume');
    replica.apply(await two.s.change((c) => c.m === 'Issue' && c.id === after.id, {from}));

    // The replica equals a fresh bootstrap (compared while the group is
    // quiet: each rename queues a label stats recalculation that rewrites
    // the label ~1–2 s later, after the echo and possibly after a barrier).
    await expectConverged(two.s, replica, alice.token, repo.group);
  });
});

describe('bootstrap_required', () => {
  let alice: Account;
  let repo: Repo;

  beforeAll(async () => {
    alice = await createUser('alice');
    repo = await createRepo(alice);
  });

  test('cursor_unknown: a position ahead of the sync log; the subscription stays live', async () => {
    const {s, welcome} = await session('ws', alice);
    const from = s.mark;
    const sub = await s.subscribe([{group: repo.group, since: welcome.server_sync_id + 1_000_000}]);
    expect(sub.granted.map((g) => g.group)).toEqual([repo.group]);
    expect(await s.next('bootstrap_required', (m) => m.group === repo.group, {from})).toMatchObject({reason: 'cursor_unknown'});
    const issue = await createIssue(alice, repo, 'still live');
    await s.change((c) => c.m === 'Issue' && c.id === issue.id, {from});
  });

  test.skipIf(env.maxReplay === undefined)('replay_too_long: more than MAX_REPLAY entries to replay; nothing of them is sent', async () => {
    const max = env.maxReplay ?? 0;
    const b = await load(alice.token, repo.group);
    // MAX_REPLAY + 1 entries after the watermark (the hub needs more than
    // MAX_REPLAY). The last create is keyed, so all of them are in the sync
    // log before the subscribe (an unkeyed one may not be yet).
    for (let i = 0; i < max; i++) {
      await api('POST', `/repos/${repo.full}/labels`, {token: alice.token, body: {name: `l${i}`, color: '#00aabb'}});
    }
    await keyed('POST', `/repos/${repo.full}/labels`, {token: alice.token, body: {name: `l${max}`, color: '#00aabb'}});
    const {s} = await session('ws', alice);
    const from = s.mark;
    await s.subscribe([{group: repo.group, since: b.header.watermark}]);
    await s.next('bootstrap_required', (m) => m.group === repo.group && m.reason === 'replay_too_long', {from});
    await s.next('caught_up', undefined, {from});
    expect(s.changes((c) => c.g === repo.group && c.m === 'Label', from)).toEqual([]);
    // The client bootstraps again; the subscription it kept is live.
    const again = await load(alice.token, repo.group);
    expect(again.changes.filter((c) => c.m === 'Label')).toHaveLength(max + 1);
    const issue = await createIssue(alice, repo, 'after the re-bootstrap');
    await s.change((c) => c.m === 'Issue' && c.id === issue.id, {from});
  });

  test.skipIf(!canSQL)('cursor_trimmed: a position below the retention floor', async () => {
    const {s} = await session('ws', alice);
    const b = await load(alice.token, repo.group);
    await s.subscribeCaughtUp([{group: repo.group, since: b.header.watermark}]);
    // Keyed: in the sync log when answered, so the barrier (and the floor
    // below) is above the watermark (with an unkeyed write it may not be,
    // and the position would not be below the floor).
    const {echo} = await keyed('POST', `/repos/${repo.full}/issues`, {token: alice.token, body: {title: 'moves the head'}});
    const ok = await s.barrier();
    expect(ok.sync_id).toBeGreaterThanOrEqual(echo);
    // Retention trimmed everything up to the head (the floor only moves up;
    // the rows stay, so the old floor is put back afterwards).
    const floor = await sql.meta('log_floor');
    await sql.setMeta('log_floor', String(ok.sync_id));
    try {
      const other = await session('ws', alice);
      const from = other.s.mark;
      await other.s.subscribe([{group: repo.group, since: b.header.watermark}]);
      await other.s.next('bootstrap_required', (m) => m.group === repo.group && m.reason === 'cursor_trimmed', {from});
      expect(other.s.changes((c) => c.g === repo.group, from)).toEqual([]);
    } finally {
      await sql.setMeta('log_floor', floor ?? '0');
    }
  });

  test.skipIf(!canSQL)('trigger_repaired: a capture trigger went missing; its model is re-bootstrapped and the lost write comes back', async () => {
    const b = await load(alice.token, repo.group);
    const {s} = await session('ws', alice);
    await s.subscribeCaughtUp([{group: repo.group, since: b.header.watermark}]);
    const from = s.mark;
    await sql.dropLabelTrigger();
    // Written while the trigger is missing: not captured, so no delta.
    const lost = await api<{id: number}>('POST', `/repos/${repo.full}/labels`, {token: alice.token, body: {name: 'lost', color: '#abcdef'}});
    // The running writer's trigger watch repairs it and appends a
    // re-bootstrap marker: every subscription that can hold labels hears.
    const m = await s.next('bootstrap_required', (x) => x.group === repo.group && x.reason === 'trigger_repaired' && x.model === 'Label', {from, timeout: 60_000});
    expect(m.model).toBe('Label');
    const again = await load(alice.token, repo.group, {models: ['Label']});
    expect(again.header.models).toEqual(['Label']);
    expect(again.changes.filter((c) => c.m === 'Label').map((c) => c.id)).toContain(lost.id);
    // Captured again.
    const next = await api<{id: number}>('POST', `/repos/${repo.full}/labels`, {token: alice.token, body: {name: 'captured', color: '#abcdef'}});
    await s.change((c) => c.m === 'Label' && c.id === next.id, {from});
  });
});
