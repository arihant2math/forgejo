// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Permissions as a client sees them: refusals that never tell "forbidden"
// from "missing", grants that appear when access is given, units that
// change (permission_changed, and the units rule on resume), and
// group_revoked — after which the client purges the group and nothing of it
// reaches the session any more.

import {beforeAll, describe, expect, test} from 'vitest';
import type {Issue} from '../src/protocol/types.gen.ts';
import {type Account, type Repo, api, createIssue, createRepo, createUser, keyed} from './forgejo.ts';
import {LoadError, Replica, load} from './replica.ts';
import {closedAfterAll, connect} from './sync.ts';

const open = closedAfterAll();

async function session(who: Account, groups?: Parameters<typeof connect>[2]) {
  const r = await connect('ws', who.token, groups);
  open.push(r.s);
  return r;
}

async function loadStatus(token: string, group: string): Promise<{status: number; body: string}> {
  try {
    const b = await load(token, group);
    return {status: b.status, body: ''};
  } catch (err) {
    if (err instanceof LoadError) return {status: err.status, body: err.body};
    throw err;
  }
}

describe('permissions', () => {
  let alice: Account;
  let bob: Account;
  let secret: Repo;

  beforeAll(async () => {
    alice = await createUser('alice');
    bob = await createUser('bob');
    secret = await createRepo(alice, {private: true});
    await createIssue(alice, secret, 'private issue');
  });

  test('an unreadable group is refused exactly like a missing one', async () => {
    const {s, welcome} = await session(bob);
    expect(welcome.grants.map((g) => g.group)).not.toContain(secret.group);
    const sub = await s.subscribe([{group: secret.group}, {group: 'repo:999999999'}, {group: '!perm'}, {group: '*'}]);
    expect(sub.granted).toEqual([]);
    expect(sub.refused).toEqual([
      {group: secret.group, reason: 'forbidden'}, {group: 'repo:999999999', reason: 'forbidden'},
      {group: '!perm', reason: 'forbidden'}, {group: '*', reason: 'forbidden'},
    ]);
    const forbidden = await loadStatus(bob.token, secret.group);
    const missing = await loadStatus(bob.token, 'repo:999999999');
    expect(forbidden).toEqual({status: 404, body: '{"message":"Not Found"}\n'});
    expect(missing).toEqual(forbidden);
  });

  test('access given → grants; units changed → permission_changed (and the units rule on resume); access taken → group_revoked and purge', async () => {
    const {s} = await session(bob);

    // Made a collaborator: the session hears about the new implicit grant.
    let from = s.mark;
    await api('PUT', `/repos/${secret.full}/collaborators/${bob.login}`, {token: alice.token, body: {permission: 'read'}});
    const grants = await s.next('grants', (m) => m.grants.some((g) => g.group === secret.group), {from});
    const units = grants.grants.find((g) => g.group === secret.group)?.units;
    expect(units).toEqual(expect.arrayContaining(['code', 'issues']));

    // Bootstrap and subscribe from the watermark.
    const b = await load(bob.token, secret.group);
    expect(b.header.units).toEqual(units);
    const replica = new Replica();
    replica.bootstrap(b);
    expect([...replica.state(secret.group, 'Issue').values()].map((d) => (d as Issue).title)).toEqual(['private issue']);
    const sub = await s.subscribeCaughtUp([{group: secret.group, since: b.header.watermark}]);
    expect(sub.granted).toEqual([{group: secret.group, units}]);
    from = s.mark;
    const live = await createIssue(alice, secret, 'seen by bob');
    replica.apply(await s.change((c) => c.m === 'Issue' && c.id === live.id, {from}));

    // The issues unit is turned off: bob's units in the group shrink.
    from = s.mark;
    await api('PATCH', `/repos/${secret.full}`, {token: alice.token, body: {has_issues: false}});
    await s.next('bootstrap_required', (m) => m.group === secret.group && m.reason === 'permission_changed', {from});
    const shrunk = await load(bob.token, secret.group);
    expect(shrunk.header.units).not.toContain('issues');
    replica.bootstrap(shrunk);
    expect(replica.state(secret.group, 'Issue').size).toBe(0);
    await s.barrier();
    const cursor = s.position(secret.group) ?? 0;
    s.close();

    // While bob is away the unit comes back: the replay cannot tell him, the
    // grant's units do (they differ from the units he holds the group with).
    await api('PATCH', `/repos/${secret.full}`, {token: alice.token, body: {has_issues: true}});
    const back = await session(bob, [{group: secret.group, since: cursor}]);
    const grant = back.welcome.granted.find((g) => g.group === secret.group);
    expect(grant?.units).toEqual(units);
    expect(grant?.units).not.toEqual(shrunk.header.units);
    await back.s.next('caught_up');
    const full = await load(bob.token, secret.group);
    expect(full.header.units).toEqual(units);
    replica.bootstrap(full);
    expect(replica.state(secret.group, 'Issue').size).toBe(2);

    // Collaboration removed: group_revoked; the client purges; nothing more
    // of the group arrives, its bootstrap is refused and so is a subscribe.
    from = back.s.mark;
    await api('DELETE', `/repos/${secret.full}/collaborators/${bob.login}`, {token: alice.token});
    await back.s.next('group_revoked', (m) => m.group === secret.group, {from});
    replica.purge(secret.group);
    expect(replica.count(secret.group)).toBe(0);
    // A keyed write is in the sync log when answered, so the barrier after
    // it covers it (with an unkeyed one the check could pass vacuously).
    const revokedAt = back.s.mark;
    const {echo} = await keyed('POST', `/repos/${secret.full}/issues`, {token: alice.token, body: {title: 'not for bob'}});
    expect((await back.s.barrier()).sync_id).toBeGreaterThanOrEqual(echo);
    expect(back.s.changes((c) => c.g === secret.group, revokedAt)).toEqual([]);
    expect((await loadStatus(bob.token, secret.group)).status).toBe(404);
    const again = await back.s.subscribe([{group: secret.group}]);
    expect(again.refused).toEqual([{group: secret.group, reason: 'forbidden'}]);
  });

  test('a public repository made private: on-demand subscribers lose it and its issues', async () => {
    const pub = await createRepo(alice);
    const issue = await createIssue(alice, pub, 'public for now', 'body');
    const {s, welcome} = await session(bob);
    expect(welcome.grants.map((g) => g.group)).not.toContain(pub.group);
    const sub = await s.subscribeCaughtUp([{group: pub.group}, {group: `issue:${issue.id}`}]);
    expect(sub.granted.map((g) => g.group)).toEqual([pub.group, `issue:${issue.id}`]);
    const from = s.mark;
    await api('PATCH', `/repos/${pub.full}`, {token: alice.token, body: {private: true}});
    await s.next('group_revoked', (m) => m.group === pub.group, {from});
    await s.next('group_revoked', (m) => m.group === `issue:${issue.id}`, {from});
    const {echo} = await keyed('POST', `/repos/${pub.full}/issues/${issue.number}/comments`, {token: alice.token, body: {body: 'hidden'}});
    expect((await s.barrier()).sync_id).toBeGreaterThanOrEqual(echo);
    expect(s.changes((c) => c.g === pub.group || c.g === `issue:${issue.id}`, from)).toEqual([]);
    // Its owner still gets everything.
    const owner = await session(alice, [{group: `issue:${issue.id}`}]);
    await owner.s.next('caught_up');
    const ownFrom = owner.s.mark;
    const c = await api<{id: number}>('POST', `/repos/${pub.full}/issues/${issue.number}/comments`, {token: alice.token, body: {body: 'for the owner'}});
    await owner.s.change((x) => x.m === 'Comment' && x.id === c.id, {from: ownFrom});
  });
});
