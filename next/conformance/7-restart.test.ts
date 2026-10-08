// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The server going away under its clients.
//
// A graceful restart: sessions are told (notice{shutdown}) and closed; a
// client resumes every group from its position after the restart and loses
// nothing.
//
// No duplicates after a forced crash between the commit and the idempotency
// record (PLAN §4.8 crash window, Phase 1 exit). The materializer is stalled
// (its sync log head row held), so a keyed issue create commits and then
// waits for its sync id with its idempotency record still in flight; the
// server is killed (SIGKILL) right then and started again. The client never
// got an answer and retries with the same key: it must get the issue that
// was created, not a second one — in API v1, in the sync log, in a resumed
// session and in a fresh bootstrap.

import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import {exec} from 'node:child_process';
import type {Issue} from '../src/protocol/types.gen.ts';
import {canCrash, canRestart, env} from './env.ts';
import {type Account, type Repo, api, createIssue, createRepo, createUser, eventually, request, syncId, unique} from './forgejo.ts';
import {Replica, load, stateOf} from './replica.ts';
import {type OpenTx, sql} from './sql.ts';
import {type Session, connect} from './sync.ts';

function shell(cmd: string | undefined): Promise<void> {
  if (!cmd) throw new Error('no command');
  return new Promise((resolve, reject) => {
    exec(cmd, {timeout: 240_000}, (err, _out, stderr) => {
      if (err) reject(new Error(`${cmd}: ${err.message} ${stderr}`));
      else resolve();
    });
  });
}

async function issuesTitled(who: Account, repo: Repo, title: string): Promise<{id: number}[]> {
  const list = await api<{id: number; title: string}[]>('GET', `/repos/${repo.full}/issues?state=all&type=issues&limit=50`, {token: who.token});
  return list.filter((i) => i.title === title);
}

const open: Session[] = [];
let hold: OpenTx | undefined;

afterAll(async () => {
  await hold?.rollback();
  for (const s of open) s.close();
  // Whatever happened, leave the server running for the next file / run.
  const up = await fetch(`${env.url}/api/v1/version`).then((r) => r.ok, () => false);
  if (!up && env.startCmd) await shell(env.startCmd);
});

describe.skipIf(!canRestart)('a graceful restart', () => {
  test('sessions get notice{shutdown} and are closed; a resume from the positions loses nothing', async () => {
    const alice = await createUser('alice');
    const repo = await createRepo(alice);
    const b = await load(alice.token, repo.group);
    const replica = new Replica();
    replica.bootstrap(b);
    const {s} = await connect('ws', alice.token, [{group: repo.group, since: b.header.watermark}]);
    open.push(s);
    await s.next('caught_up');
    // Writes right before the shutdown: received or not, the resume has them.
    for (let i = 0; i < 5; i++) await request('POST', `/api/v1/repos/${repo.full}/issues`, {token: alice.token, key: unique('key'), body: {title: `before ${i}`}});
    await shell(env.stopCmd);
    expect((await s.whenClosed()).code).toBe(1001);
    expect(s.messages.some((m) => m.type === 'notice' && m.kind === 'shutdown')).toBe(true);
    for (const c of s.changes((x) => x.g === repo.group)) replica.apply(c);
    const cursor = s.position(repo.group) ?? b.header.watermark;
    await shell(env.startCmd);

    const again = await connect('ws', alice.token, [{group: repo.group, since: cursor}]);
    open.push(again.s);
    await again.s.next('caught_up');
    await again.s.barrier();
    for (const c of again.s.changes((x) => x.g === repo.group)) replica.apply(c);
    const fresh = await load(alice.token, repo.group);
    expect(replica.state(repo.group, 'Issue').size).toBe(5);
    expect(replica.state(repo.group)).toEqual(stateOf(fresh));
    expect(again.s.violations).toEqual([]);
  });
});

describe.skipIf(!canCrash)('a crash between the commit and the idempotency record', () => {
  let alice: Account;
  let repo: Repo;

  beforeAll(async () => {
    alice = await createUser('alice');
    repo = await createRepo(alice);
    await createIssue(alice, repo, 'before the crash');
  });

  test('the retry answers the issue created before the crash; nothing is duplicated', async () => {
    const b = await load(alice.token, repo.group);
    const replica = new Replica();
    replica.bootstrap(b);
    const before = await connect('ws', alice.token, [{group: repo.group, since: b.header.watermark}]);
    open.push(before.s);
    await before.s.next('caught_up');
    await before.s.barrier();
    const cursor = before.s.position(repo.group) ?? 0;

    const title = unique('crash');
    const key = unique('key');
    const body = {title, body: 'exactly once'};
    hold = await sql.holdLogHead();
    const attempt = request('POST', `/api/v1/repos/${repo.full}/issues`, {token: alice.token, key, body})
      .then((r) => `answered ${r.status}`, (err: unknown) => `failed: ${String(err)}`);
    // API v1 committed the issue; the layer now waits for the materializer
    // with the record in flight.
    await eventually('the issue committed', async () => (await issuesTitled(alice, repo, title)).length === 1);
    expect(await sql.count('livesync_idempotency', `idem_key = '${key}' AND user_id = ${alice.id} AND state = 0`)).toBe(1);

    await shell(env.killCmd);
    expect(await attempt).toMatch(/^failed/);
    await hold.rollback();
    hold = undefined;
    await shell(env.startCmd);

    // The retry: the issue that exists, answered like the create would have been.
    const retry = await request('POST', `/api/v1/repos/${repo.full}/issues`, {token: alice.token, key, body});
    expect(retry.status).toBe(201);
    const issue = await retry.json() as {id: number; title: string; body: string};
    expect(issue).toMatchObject({title, body: 'exactly once'});
    const echo = syncId(retry);
    expect(echo).toBeDefined();
    const existing = await issuesTitled(alice, repo, title);
    expect(existing.map((i) => i.id)).toEqual([issue.id]);
    expect(await sql.count('livesync_idempotency', `idem_key = '${key}' AND user_id = ${alice.id} AND state = 1`)).toBe(1);

    // From now on a plain replay.
    const replay = await request('POST', `/api/v1/repos/${repo.full}/issues`, {token: alice.token, key, body});
    expect(replay.headers.get('X-Livesync-Idempotent-Replay')).toBe('true');
    expect((await replay.json() as {id: number}).id).toBe(issue.id);
    expect(syncId(replay)).toBe(echo);

    // The session resumes from its position before the crash: the issue
    // once, at or below the echo; the replica converges with a bootstrap.
    const after = await connect('ws', alice.token, [{group: repo.group, since: cursor}]);
    open.push(after.s);
    await after.s.next('caught_up');
    await after.s.barrier();
    const mine = after.s.changes((c) => c.m === 'Issue' && (c.d as Issue | undefined)?.title === title);
    expect(new Set(mine.map((c) => c.id))).toEqual(new Set([issue.id]));
    expect(mine[0]?.v).toBeLessThanOrEqual(echo ?? 0);
    for (const c of after.s.changes((x) => x.g === repo.group)) replica.apply(c);
    const fresh = await load(alice.token, repo.group);
    expect(fresh.changes.filter((c) => c.m === 'Issue' && (c.d as Issue).title === title)).toHaveLength(1);
    expect(replica.state(repo.group)).toEqual(stateOf(fresh));
    expect(after.s.violations).toEqual([]);
  });
});
