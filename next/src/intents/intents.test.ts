// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The overlay and the online intent executor (F4): synchronous local apply,
// API v1 with Idempotency-Key, overlay dropped on the sync-id echo (B7)
// without ever showing the old value again, rollback on rejection.

import {autorun} from 'mobx';
import {describe, expect, test, vi} from 'vitest';
import {Pool} from '../data/pool.ts';
import {issue, repo, T, user} from '../test/fakeSession.ts';
import {Intents, type IntentEnv, type Rejection} from './executor.ts';
import {type Intent, intentOps, newIntent} from './intents.ts';
import {Overlay} from './overlay.ts';
import {requestFor} from './rest.ts';
import {issueAssigneeIds, issueLabelIds, issueState} from './view.ts';

let v = 100;

function world() {
  const pool = new Pool();
  const dev = user(1, 'dev');
  pool.batch(() => {
    pool.put('User', 1, 'profiles:public', ++v, dev);
    pool.put('User', 2, 'profiles:public', ++v, user(2, 'alice'));
    pool.put('Repository', 10, 'repo:10', ++v, repo(10, dev, 'big'));
    pool.put('Issue', 7, 'repo:10', ++v, issue(7, 10, 3, 'Crash'));
    pool.put('Label', 50, 'repo:10', ++v, {id: 50, repo_id: 10, org_id: 0, name: 'bug', exclusive: false, description: '', color: '#e11d48', num_issues: 0, num_closed_issues: 0, created_at: T});
    pool.put('IssueAssignee', 900, 'repo:10', ++v, {id: 900, issue_id: 7, assignee_id: 1});
  });
  return {pool, overlay: new Overlay()};
}

/** A scripted fetch: answers in order, records requests. */
function server(answers: (Response | Error)[]) {
  const calls: {url: string; init: RequestInit}[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    calls.push({url, init});
    const a = answers.shift();
    if (!a) return Promise.reject(new Error('no answer scripted'));
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  });
  return {fetch: fetch as unknown as typeof globalThis.fetch, calls};
}

const ok = (syncId?: number, status = 200) => new Response('{}', {status, headers: syncId ? {'X-Livesync-Sync-Id': String(syncId)} : {}});

function executor(w: ReturnType<typeof world>, fetch: typeof globalThis.fetch, extra: Partial<IntentEnv> = {}) {
  const rejected: [Intent, Rejection][] = [];
  const synced: {group: string; v: number; resolve: () => void}[] = [];
  const intents = new Intents({
    pool: w.pool, overlay: w.overlay, apiBase: '/api/v1', fetch, backoff: 1,
    token: () => Promise.resolve('tok'), refresh: () => Promise.resolve('tok2'), online: () => true,
    whenSynced: (group, sv) => new Promise((resolve) => synced.push({group, v: sv, resolve})),
    onRejected: (i, r) => rejected.push([i, r]),
    sleep: () => Promise.resolve(),
    ...extra,
  });
  return {intents, rejected, synced};
}

describe('overlay', () => {
  test('the latest layer wins; removing one reveals the one below, then the server', () => {
    const o = new Overlay();
    o.add('a', [{t: 'field', model: 'Issue', id: 1, field: 'state', value: 'closed'}]);
    o.add('b', [{t: 'field', model: 'Issue', id: 1, field: 'state', value: 'open'}]);
    expect(o.field('Issue', 1, 'state')).toEqual({value: 'open'});
    o.remove('b');
    expect(o.field('Issue', 1, 'state')).toEqual({value: 'closed'});
    o.remove('a');
    expect(o.field('Issue', 1, 'state')).toBeUndefined();
    expect(o.size).toBe(0);
  });

  test('set members, and the set as of a layer', () => {
    const o = new Overlay();
    o.add('a', [{t: 'member', model: 'IssueLabel', owner: 7, member: 1, present: true}]);
    o.add('b', [{t: 'member', model: 'IssueLabel', owner: 7, member: 2, present: true}, {t: 'member', model: 'IssueLabel', owner: 7, member: 1, present: false}]);
    expect([...o.members('IssueLabel', 7) ?? []]).toEqual([[1, false], [2, true]]);
    expect([...o.membersUpTo('IssueLabel', 7, 'a', true)]).toEqual([[1, true]]);
    expect([...o.membersUpTo('IssueLabel', 7, 'b', false)]).toEqual([[1, true]]);
    expect(o.members('IssueAssignee', 7)).toBeUndefined();
  });

  test('one field’s override notifies the observers of that field only', () => {
    const o = new Overlay();
    const runs = {s1: 0, s2: 0, l1: 0, rev: 0};
    const offs = [
      autorun(() => {
        o.field('Issue', 1, 'state');
        runs.s1++;
      }),
      autorun(() => {
        o.field('Issue', 2, 'state');
        runs.s2++;
      }),
      autorun(() => {
        o.members('IssueLabel', 1);
        runs.l1++;
      }),
      autorun(() => {
        runs.rev += o.revision >= 0 ? 1 : 0;
      }),
    ];
    o.add('x', [{t: 'field', model: 'Issue', id: 1, field: 'state', value: 'closed'}]);
    expect(runs).toEqual({s1: 2, s2: 1, l1: 1, rev: 2});
    o.remove('x');
    expect(runs).toEqual({s1: 3, s2: 1, l1: 1, rev: 3});
    for (const off of offs) off();
  });

  test('intentOps: an exclusive label hides the siblings it replaces', () => {
    const i = newIntent({kind: 'issue.label', issueId: 7, repoId: 10, labelId: 3, add: true, drop: [4, 3]});
    expect(intentOps(i)).toEqual([
      {t: 'member', model: 'IssueLabel', owner: 7, member: 3, present: true},
      {t: 'member', model: 'IssueLabel', owner: 7, member: 4, present: false},
    ]);
    expect(i.id).not.toBe(i.key);
    expect(i.key).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  });
});

describe('requests (built at send time)', () => {
  test('each intent kind maps to its API v1 call', () => {
    const w = world();
    const req = (input: Parameters<typeof newIntent>[0]) => {
      const i = newIntent(input);
      w.overlay.add(i.id, intentOps(i));
      return requestFor(i, w.pool, w.overlay);
    };
    expect(req({kind: 'issue.state', issueId: 7, repoId: 10, state: 'closed', base: 'open'})).toEqual({method: 'PATCH', path: '/repos/dev/big/issues/3', body: {state: 'closed'}});
    expect(req({kind: 'issue.label', issueId: 7, repoId: 10, labelId: 50, add: true, drop: []})).toEqual({method: 'POST', path: '/repos/dev/big/issues/3/labels', body: {labels: [50]}});
    expect(req({kind: 'issue.label', issueId: 7, repoId: 10, labelId: 50, add: false, drop: []})).toEqual({method: 'DELETE', path: '/repos/dev/big/issues/3/labels/50'});
    expect(req({kind: 'issue.milestone', issueId: 7, repoId: 10, milestoneId: 0, base: 4})).toEqual({method: 'PATCH', path: '/repos/dev/big/issues/3', body: {milestone: 0}});
    // Assignees: the whole list — the server's, with this change (API v1 has no add/remove).
    expect(req({kind: 'issue.assignee', issueId: 7, repoId: 10, userId: 2, add: true})).toEqual({method: 'PATCH', path: '/repos/dev/big/issues/3', body: {assignees: ['alice', 'dev']}});
  });

  test('an assignee change sent later sees the server set as it is then (not as it was when queued)', () => {
    const w = world();
    const i = newIntent({kind: 'issue.assignee', issueId: 7, repoId: 10, userId: 2, add: true});
    w.overlay.add(i.id, intentOps(i));
    w.pool.batch(() => w.pool.del('IssueAssignee', 900, 'repo:10', ++v)); // someone unassigned dev meanwhile
    expect(requestFor(i, w.pool, w.overlay).body).toEqual({assignees: ['alice']});
  });
});

describe('executor', () => {
  test('applies at once, sends with a stable Idempotency-Key, and drops the overlay only when the pool reached the echo', async () => {
    const w = world();
    const s = server([ok(500)]);
    const {intents, synced} = executor(w, s.fetch);
    const issue7 = w.pool.model('Issue').get(7);
    if (!issue7) throw new Error('fixture');
    const seen: string[] = [];
    const off = autorun(() => {
      seen.push(issueState(w.overlay, issue7));
    });
    intents.submit({kind: 'issue.state', issueId: 7, repoId: 10, state: 'closed', base: 'open'});
    expect(seen).toEqual(['open', 'closed']); // synchronously, before any network
    await vi.waitFor(() => {
      expect(synced).toHaveLength(1);
    });
    const call = s.calls[0];
    expect(call?.url).toBe('/api/v1/repos/dev/big/issues/3');
    expect(call?.init.method).toBe('PATCH');
    expect(new Headers(call?.init.headers).get('Idempotency-Key')).toMatch(/^[\da-f-]{36}$/);
    expect(new Headers(call?.init.headers).get('Authorization')).toBe('Bearer tok');
    expect(synced[0]).toMatchObject({group: 'repo:10', v: 500});
    expect(intents.phases.size).toBe(1);
    // The delta arrives (the pool reaches 500) and then the echo resolves: never "open" again.
    w.pool.batch(() => w.pool.put('Issue', 7, 'repo:10', 500, issue(7, 10, 3, 'Crash', {state: 'closed'})));
    synced[0]?.resolve();
    await vi.waitFor(() => {
      expect(w.overlay.size).toBe(0);
    });
    // The value never went back to "open" (the overlay's drop re-ran the reaction with the same value).
    expect(seen[0]).toBe('open');
    expect(seen.slice(1).every((x) => x === 'closed')).toBe(true);
    expect(intents.phases.size).toBe(0);
    off();
  });

  test('a refusal rolls back and reports; the issue shows the server value again', async () => {
    const w = world();
    const s = server([new Response(JSON.stringify({message: 'label not found'}), {status: 422})]);
    const {intents, rejected} = executor(w, s.fetch);
    intents.submit({kind: 'issue.label', issueId: 7, repoId: 10, labelId: 50, add: true, drop: []});
    expect(issueLabelIds(w.pool, w.overlay, 7)).toEqual([50]);
    await vi.waitFor(() => {
      expect(rejected).toHaveLength(1);
    });
    expect(rejected[0]?.[1]).toMatchObject({reason: 'refused', status: 422, message: 'label not found'});
    expect(issueLabelIds(w.pool, w.overlay, 7)).toEqual([]);
    expect(w.overlay.size).toBe(0);
  });

  test('retries keep the key: network errors, 409 in flight, 5xx; a 401 refreshes the token once', async () => {
    const w = world();
    const s = server([new TypeError('network'), new Response('', {status: 409, headers: {'Retry-After': '1'}}), new Response('', {status: 502}), new Response('', {status: 401}), ok(600)]);
    const sleep = vi.fn(() => Promise.resolve());
    const {intents, synced} = executor(w, s.fetch, {sleep});
    intents.submit({kind: 'issue.assignee', issueId: 7, repoId: 10, userId: 2, add: true});
    await vi.waitFor(() => {
      expect(synced).toHaveLength(1);
    });
    const keys = new Set(s.calls.map((c) => new Headers(c.init.headers).get('Idempotency-Key')));
    expect(s.calls).toHaveLength(5);
    expect(keys.size).toBe(1);
    expect(new Headers(s.calls[4]?.init.headers).get('Authorization')).toBe('Bearer tok');
    expect(sleep).toHaveBeenCalledWith(1000); // Retry-After
  });

  test('offline: rejected at once (no queue before F5)', async () => {
    const w = world();
    const s = server([]);
    const {intents, rejected} = executor(w, s.fetch, {online: () => false});
    intents.submit({kind: 'issue.state', issueId: 7, repoId: 10, state: 'closed', base: 'open'});
    await vi.waitFor(() => {
      expect(rejected).toHaveLength(1);
    });
    expect(rejected[0]?.[1].reason).toBe('offline');
    expect(s.calls).toHaveLength(0);
    expect(w.overlay.size).toBe(0);
  });

  test('intents of one issue are sent one after the other, in order', async () => {
    const w = world();
    let release: (() => void) | undefined;
    const order: string[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      order.push(init.body as string);
      if (order.length === 1) return new Promise<Response>((r) => {
        release = () => {
          r(ok(701));
        };
      });
      return Promise.resolve(ok(702));
    }) as unknown as typeof globalThis.fetch;
    const {intents} = executor(w, fetch);
    intents.submit({kind: 'issue.state', issueId: 7, repoId: 10, state: 'closed', base: 'open'});
    intents.submit({kind: 'issue.state', issueId: 7, repoId: 10, state: 'open', base: 'closed'});
    await vi.waitFor(() => {
      expect(order).toHaveLength(1);
    });
    await Promise.resolve();
    expect(order).toHaveLength(1);
    release?.();
    await vi.waitFor(() => {
      expect(order).toEqual(['{"state":"closed"}', '{"state":"open"}']);
    });
    // The second layer stays on top while the first is confirmed.
    const issue7 = w.pool.model('Issue').get(7);
    if (issue7) expect(issueState(w.overlay, issue7)).toBe('open');
  });

  test('no sync id (the server’s wait timed out): the layer stays until the issue changes', async () => {
    const w = world();
    const s = server([ok(undefined, 201)]);
    const {intents} = executor(w, s.fetch);
    intents.submit({kind: 'issue.label', issueId: 7, repoId: 10, labelId: 50, add: true, drop: []});
    await vi.waitFor(() => {
      expect(intents.phases.get([...intents.phases.keys()][0] ?? '')).toBe('confirming');
    });
    expect(w.overlay.size).toBe(1);
    w.pool.batch(() => w.pool.put('IssueLabel', 901, 'repo:10', ++v, {id: 901, issue_id: 7, label_id: 50}));
    await vi.waitFor(() => {
      expect(w.overlay.size).toBe(0);
    });
    expect(issueLabelIds(w.pool, w.overlay, 7)).toEqual([50]);
    expect(issueAssigneeIds(w.pool, w.overlay, 7)).toEqual([1]);
  });

  // Review regressions (correctness review round 1).
  test('no sync id: a change elsewhere (another issue’s label deleted) keeps the layer', async () => {
    const w = world();
    w.pool.batch(() => {
      w.pool.put('Issue', 8, 'repo:10', ++v, issue(8, 10, 4, 'Other'));
      w.pool.put('IssueLabel', 800, 'repo:10', ++v, {id: 800, issue_id: 8, label_id: 50});
    });
    const {intents} = executor(w, server([ok()]).fetch);
    intents.submit({kind: 'issue.label', issueId: 7, repoId: 10, labelId: 50, add: true, drop: []});
    await vi.waitFor(() => {
      expect([...intents.phases.values()]).toEqual(['confirming']);
    });
    w.pool.batch(() => w.pool.del('IssueLabel', 800, 'repo:10', ++v));
    await new Promise((r) => setTimeout(r, 10));
    expect(w.overlay.size).toBe(1);
    expect(issueLabelIds(w.pool, w.overlay, 7)).toEqual([50]);
  });

  test('no sync id: the echo of an earlier intent of the issue does not drop a later layer', async () => {
    const w = world();
    const {intents, synced} = executor(w, server([ok(500), ok()]).fetch);
    intents.submit({kind: 'issue.state', issueId: 7, repoId: 10, state: 'closed', base: 'open'});
    intents.submit({kind: 'issue.label', issueId: 7, repoId: 10, labelId: 50, add: true, drop: []});
    await vi.waitFor(() => {
      expect([...intents.phases.values()]).toEqual(['confirming', 'confirming']);
    });
    w.pool.batch(() => w.pool.put('Issue', 7, 'repo:10', 500, issue(7, 10, 3, 'Crash', {state: 'closed'})));
    synced[0]?.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(issueLabelIds(w.pool, w.overlay, 7)).toEqual([50]);
  });

  test('no sync id, then a later intent echoed: the earlier layer goes with it (its effect may never show)', async () => {
    const w = world();
    const {intents, synced} = executor(w, server([ok(), ok(600)]).fetch);
    intents.submit({kind: 'issue.state', issueId: 7, repoId: 10, state: 'closed', base: 'open'});
    intents.submit({kind: 'issue.state', issueId: 7, repoId: 10, state: 'open', base: 'closed'});
    await vi.waitFor(() => {
      expect(synced).toHaveLength(1);
    });
    // Both writes reached the pool as one change: "closed" was never seen.
    w.pool.batch(() => w.pool.put('Issue', 7, 'repo:10', 600, issue(7, 10, 3, 'Crash', {state: 'open'})));
    synced[0]?.resolve();
    await vi.waitFor(() => {
      expect(w.overlay.size).toBe(0);
    });
    const issue7 = w.pool.model('Issue').get(7);
    if (issue7) expect(issueState(w.overlay, issue7)).toBe('open');
  });

  test('at most 6 requests in flight across issues (a bulk edit queues)', async () => {
    const w = world();
    w.pool.batch(() => {
      for (let n = 100; n < 120; n++) w.pool.put('Issue', n, 'repo:10', ++v, issue(n, 10, n, `I${String(n)}`));
    });
    let inFlight = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const fetch = vi.fn(() => {
      inFlight++;
      most = Math.max(most, inFlight);
      return new Promise<Response>((r) => releases.push(() => {
        inFlight--;
        r(ok(700));
      }));
    }) as unknown as typeof globalThis.fetch;
    const {intents} = executor(w, fetch);
    for (let n = 100; n < 120; n++) intents.submit({kind: 'issue.state', issueId: n, repoId: 10, state: 'closed', base: 'open'});
    for (let k = 0; k < 20; k++) {
      await vi.waitFor(() => {
        expect(releases.length).toBeGreaterThan(0);
      });
      releases.shift()?.();
    }
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(20);
    });
    expect(most).toBe(6);
  });

  test('a retry under the same key sends the same request, even if the pool changed meanwhile (B7: else 422)', async () => {
    const w = world();
    w.pool.batch(() => w.pool.put('User', 3, 'profiles:public', ++v, user(3, 'bob')));
    const calls: RequestInit[] = [];
    const fetch = vi.fn((_u: string, init: RequestInit) => {
      calls.push(init);
      if (calls.length === 1) {
        w.pool.batch(() => w.pool.put('IssueAssignee', 901, 'repo:10', ++v, {id: 901, issue_id: 7, assignee_id: 3}));
        return Promise.resolve(new Response('', {status: 409, headers: {'Retry-After': '1'}}));
      }
      return Promise.resolve(ok(600));
    }) as unknown as typeof globalThis.fetch;
    const {intents, synced} = executor(w, fetch);
    intents.submit({kind: 'issue.assignee', issueId: 7, repoId: 10, userId: 2, add: true});
    await vi.waitFor(() => {
      expect(synced).toHaveLength(1);
    });
    const key = (i: RequestInit | undefined) => new Headers(i?.headers).get('Idempotency-Key');
    expect(key(calls[1])).toBe(key(calls[0]));
    expect(calls[1]?.body).toBe(calls[0]?.body);
  });

  test('a slow echo asks for a barrier; the confirm timeout drops the layer in the end', async () => {
    const w = world();
    const barrier = vi.fn(() => Promise.resolve(0));
    const {intents} = executor(w, server([ok(700)]).fetch, {barrier, barrierAfter: 5, confirmTimeout: 40});
    intents.submit({kind: 'issue.state', issueId: 7, repoId: 10, state: 'closed', base: 'open'});
    await vi.waitFor(() => {
      expect(barrier).toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(w.overlay.size).toBe(0);
    });
  });

  test('a rejected intent below a pending one: the pending one still shows', async () => {
    const w = world();
    const {intents, rejected} = executor(w, server([new Response('{}', {status: 403}), ok(800)]).fetch);
    const issue7 = w.pool.model('Issue').get(7);
    if (!issue7) throw new Error('fixture');
    intents.submit({kind: 'issue.state', issueId: 7, repoId: 10, state: 'closed', base: 'open'});
    intents.submit({kind: 'issue.label', issueId: 7, repoId: 10, labelId: 50, add: true, drop: []});
    await vi.waitFor(() => {
      expect(rejected).toHaveLength(1);
    });
    expect(issueState(w.overlay, issue7)).toBe('open');
    expect(issueLabelIds(w.pool, w.overlay, 7)).toEqual([50]);
  });
});
