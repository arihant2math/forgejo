// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The overlay and the durable intent queue: synchronous local apply, the
// IndexedDB queue (before anything is sent), flush rules (after caught_up,
// per entity, temporary ids), stable Idempotency-Keys with frozen requests,
// confirmation without flicker, conflict policies, drafts on every failure,
// tabs (followers hand over through IndexedDB, the leader flushes).

import {autorun, untracked} from 'mobx';
import {describe, expect, test, vi} from 'vitest';
import {Pool} from '../data/pool.ts';
import {ALICE, DEV, FakeForgejo, REPO} from '../test/fakeForgejo.ts';
import {comment, issue, repo, T, user} from '../test/fakeSession.ts';
import {World} from '../test/fakeTabs.ts';
import {type IntentInput, intentOps, newIntent, remapIntent, tempNum, tempRefs} from './intents.ts';
import {Overlay} from './overlay.ts';
import {requestFor} from './rest.ts';
import {IntentDb} from './store.ts';
import {takeCollected} from '../sync/rum.ts';
import {issueAssigneeIds, issueBody, issueComments, issueLabelIds, issueState, issueTitle} from './view.ts';

let v = 100;

function poolWorld() {
  const pool = new Pool();
  const dev = user(1, 'dev');
  pool.batch(() => {
    pool.put('User', 1, 'profiles:public', ++v, dev);
    pool.put('User', 2, 'profiles:public', ++v, user(2, 'alice'));
    pool.put('Repository', 10, 'repo:10', ++v, repo(10, dev, 'big'));
    pool.put('Issue', 7, 'repo:10', ++v, issue(7, 10, 3, 'Crash'));
    pool.put('Issue', 8, 'repo:10', ++v, issue(8, 10, 4, 'Other'));
    pool.put('Label', 50, 'repo:10', ++v, {id: 50, repo_id: 10, org_id: 0, name: 'bug', exclusive: false, description: '', color: '#e11d48', num_issues: 0, num_closed_issues: 0, created_at: T});
    pool.put('IssueAssignee', 900, 'repo:10', ++v, {id: 900, issue_id: 7, assignee_id: 1});
  });
  return {pool, overlay: new Overlay()};
}

/** A scripted server answer for one request. */
const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(body), {status, headers});

/** A fetch that answers from a script first, then from the fake server. */
function scripted(server: FakeForgejo, script: (Response | Error | undefined)[]) {
  const calls: {url: string; key: string; body: string}[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({url, key: new Headers(init.headers).get('Idempotency-Key') ?? '', body: typeof init.body === 'string' ? init.body : ''});
    const a = script.shift();
    if (a instanceof Error) throw a;
    if (a) return a;
    return server.fetch(url, init);
  });
  return {fetch: fetch as unknown as typeof globalThis.fetch, calls};
}

const ref = {issueId: 1, repoId: REPO};

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

  test('set members (numbers and strings), and the set as of a layer', () => {
    const o = new Overlay();
    o.add('a', [{t: 'member', model: 'IssueLabel', owner: 7, member: 1, present: true}]);
    o.add('b', [{t: 'member', model: 'IssueLabel', owner: 7, member: 2, present: true}, {t: 'member', model: 'IssueLabel', owner: 7, member: 1, present: false}]);
    expect([...o.members('IssueLabel', 7) ?? []]).toEqual([[1, false], [2, true]]);
    expect([...o.membersUpTo('IssueLabel', 7, 'a', true)]).toEqual([[1, true]]);
    o.add('c', [{t: 'member', model: 'ViewedFile', owner: 7, member: 'src/a.go', present: true}]);
    expect([...o.members('ViewedFile', 7) ?? []]).toEqual([['src/a.go', true]]);
  });

  test('one field’s override notifies the observers of that field only; created entities notify their model', () => {
    const o = new Overlay();
    const runs = {s1: 0, s2: 0, l1: 0, rev: 0, created: 0};
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
      autorun(() => {
        o.created('Comment');
        runs.created++;
      }),
    ];
    o.add('x', [{t: 'field', model: 'Issue', id: 1, field: 'state', value: 'closed'}]);
    expect(runs).toEqual({s1: 2, s2: 1, l1: 1, rev: 2, created: 1});
    o.remove('x');
    expect(runs).toEqual({s1: 3, s2: 1, l1: 1, rev: 3, created: 1});
    const c = newIntent({...ref, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'hi'});
    o.add(c.id, intentOps(c, {userId: 1}));
    expect(runs.created).toBe(2);
    expect(o.created('Comment').map((e) => e.id)).toEqual([tempNum(c.kind === 'comment.create' ? c.tempId : '')]);
    for (const off of offs) off();
  });

  test('intentOps: an exclusive label hides the siblings it replaces; keys are v4 UUIDs', () => {
    const i = newIntent({kind: 'issue.label', issueId: 7, repoId: 10, labelId: 3, add: true, drop: [4, 3]});
    expect(intentOps(i)).toEqual([
      {t: 'member', model: 'IssueLabel', owner: 7, member: 3, present: true},
      {t: 'member', model: 'IssueLabel', owner: 7, member: 4, present: false},
    ]);
    expect(i.id).not.toBe(i.key);
    expect(i.key).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  });

  test('temporary ids: negative, stable, remapped in dependent intents', () => {
    const t = crypto.randomUUID();
    expect(tempNum(t)).toBeLessThan(0);
    expect(tempNum(t)).toBe(tempNum(t));
    expect(Number.isSafeInteger(tempNum(t))).toBe(true);
    const c = newIntent({kind: 'comment.create', issueId: tempNum(t), repoId: 10, tempId: crypto.randomUUID(), body: 'x'});
    expect(tempRefs(c)).toEqual([tempNum(t)]);
    expect(remapIntent(c, tempNum(t), 77).issueId).toBe(77);
    const same = newIntent({...ref, kind: 'issue.state', state: 'closed', base: 'open'});
    expect(remapIntent(same, tempNum(t), 77)).toBe(same);
  });
});

describe('requests (built at send time)', () => {
  test('each intent kind maps to its API call', () => {
    const w = poolWorld();
    const req = (input: IntentInput) => {
      const i = newIntent(input);
      w.overlay.add(i.id, intentOps(i));
      return requestFor(i, w.pool, w.overlay);
    };
    const r = {issueId: 7, repoId: 10};
    const base = '/repos/dev/big/issues/3';
    expect(req({...r, kind: 'issue.state', state: 'closed', base: 'open'})).toEqual({method: 'PATCH', api: 'v1', path: base, body: {state: 'closed'}});
    expect(req({...r, kind: 'issue.title', title: 'New', base: 'Crash'})).toEqual({method: 'PATCH', api: 'v1', path: base, body: {title: 'New'}});
    expect(req({...r, kind: 'issue.deadline', due: '2026-12-01', base: null})).toEqual({method: 'PATCH', api: 'v1', path: base, body: {due_date: '2026-12-01T00:00:00Z'}});
    expect(req({...r, kind: 'issue.deadline', due: null, base: '2026-12-01'})).toEqual({method: 'PATCH', api: 'v1', path: base, body: {unset_due_date: true}});
    expect(req({...r, kind: 'issue.label', labelId: 50, add: true, drop: []})).toEqual({method: 'POST', api: 'v1', path: `${base}/labels`, body: {labels: [50]}});
    expect(req({...r, kind: 'issue.label', labelId: 50, add: false, drop: []})).toEqual({method: 'DELETE', api: 'v1', path: `${base}/labels/50`});
    expect(req({...r, kind: 'issue.milestone', milestoneId: 0, base: 4})).toEqual({method: 'PATCH', api: 'v1', path: base, body: {milestone: 0}});
    expect(req({...r, kind: 'issue.pin', pinned: true})).toEqual({method: 'POST', api: 'v1', path: `${base}/pin`});
    expect(req({...r, kind: 'issue.lock', locked: true, reason: 'Resolved'})).toEqual({method: 'PUT', api: 'v1', path: `${base}/lock`, body: {reason: 'Resolved'}});
    expect(req({...r, kind: 'issue.lock', locked: false, reason: ''})).toEqual({method: 'DELETE', api: 'v1', path: `${base}/lock`});
    // Assignees: the whole list — the server's, with this change (API v1 has no add/remove).
    expect(req({...r, kind: 'issue.assignee', userId: 2, add: true})).toEqual({method: 'PATCH', api: 'v1', path: base, body: {assignees: ['alice', 'dev']}});
    expect(req({...r, kind: 'issue.dependency', dependencyId: 8, add: true})).toEqual({method: 'POST', api: 'v1', path: `${base}/dependencies`, body: {index: 4, owner: 'dev', repo: 'big'}});
    expect(req({...r, kind: 'issue.subscribe', userId: 1, add: false})).toEqual({method: 'DELETE', api: 'v1', path: `${base}/subscriptions/dev`});
    expect(req({...r, kind: 'issue.reviewer', userId: 2, add: true})).toEqual({method: 'POST', api: 'v1', path: '/repos/dev/big/pulls/3/requested_reviewers', body: {reviewers: ['alice']}});
    expect(req({...r, kind: 'reaction', commentId: 0, content: '+1', add: true})).toEqual({method: 'POST', api: 'v1', path: `${base}/reactions`, body: {content: '+1'}});
    expect(req({...r, kind: 'reaction', commentId: 33, content: 'heart', add: false})).toEqual({method: 'DELETE', api: 'v1', path: '/repos/dev/big/issues/comments/33/reactions', body: {content: 'heart'}});
    expect(req({...r, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'hi'})).toEqual({method: 'POST', api: 'v1', path: `${base}/comments`, body: {body: 'hi'}});
    expect(req({...r, kind: 'comment.edit', commentId: 33, text: 'b', baseText: 'a', baseVersion: 2, baseUpdated: T})).toEqual({method: 'PATCH', api: 'sync', path: '/comments/33/body', body: {body: 'b', expected_version: 2}});
    expect(req({...r, kind: 'comment.delete', commentId: 33})).toEqual({method: 'DELETE', api: 'v1', path: '/repos/dev/big/issues/comments/33'});
    expect(req({...r, kind: 'issue.body', text: 'b', baseText: 'a', baseVersion: 1})).toEqual({method: 'PATCH', api: 'sync', path: '/issues/7/body', body: {body: 'b', expected_version: 1}});
    expect(req({...r, kind: 'board.move', projectId: 5, columnId: 6, position: 0, baseColumn: 2})).toEqual({method: 'POST', api: 'sync', path: '/projects/5/columns/6/cards', body: {issue_id: 7, position: 0}});
    expect(req({...r, kind: 'pr.viewed', commitSha: 'abc', files: {'a.go': true}})).toEqual({method: 'PUT', api: 'sync', path: '/issues/7/viewed', body: {commit_sha: 'abc', files: {'a.go': true}}});
    expect(req({...r, kind: 'notification.status', notificationId: 9, status: 'read', base: 'unread'})).toEqual({method: 'PATCH', api: 'v1', path: '/notifications/threads/9?to-status=read'});
    expect(req({...r, kind: 'review.submit', tempId: crypto.randomUUID(), commitId: 'c0ffee', event: 'COMMENT', body: 'ok', comments: [{path: 'a.go', body: 'nit', newLine: 3, oldLine: 0}]}))
      .toEqual({method: 'POST', api: 'v1', path: '/repos/dev/big/pulls/3/reviews', body: {commit_id: 'c0ffee', event: 'COMMENT', body: 'ok', comments: [{path: 'a.go', body: 'nit', new_position: 3, old_position: 0}]}});
    expect(req({repoId: 10, issueId: tempNum(crypto.randomUUID()), kind: 'issue.create', tempId: crypto.randomUUID(), title: 'T', body: 'B', labelIds: [50], assigneeIds: [2], milestoneId: 0}))
      .toEqual({method: 'POST', api: 'v1', path: '/repos/dev/big/issues', body: {title: 'T', body: 'B', labels: [50], assignees: ['alice']}});
  });

  test('an assignee change sent later sees the server set as it is then (not as it was when queued)', () => {
    const w = poolWorld();
    const i = newIntent({kind: 'issue.assignee', issueId: 7, repoId: 10, userId: 2, add: true});
    w.overlay.add(i.id, intentOps(i));
    w.pool.batch(() => w.pool.del('IssueAssignee', 900, 'repo:10', ++v)); // someone unassigned dev meanwhile
    expect(requestFor(i, w.pool, w.overlay).body).toEqual({assignees: ['alice']});
  });

  test('an intent on an entity created offline is not ready until the create is remapped', () => {
    const w = poolWorld();
    const i = newIntent({kind: 'comment.create', issueId: tempNum(crypto.randomUUID()), repoId: 10, tempId: crypto.randomUUID(), body: 'x'});
    expect(() => requestFor(i, w.pool, w.overlay)).toThrow(/created offline/);
  });
});

describe('the queue', () => {
  test('applies at once, is durable before it is sent, sends with a stable key, and drops the layer only once the pool holds the write', async () => {
    const server = new FakeForgejo();
    const world = new World(server, 1);
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    const i = tab.intents.submit({...ref, kind: 'issue.label', labelId: 2, add: true, drop: []});
    // The same frame: the overlay shows it.
    expect(untracked(() => issueLabelIds(tab.pool, tab.overlay, 1))).toEqual([2]);
    await vi.waitFor(async () => {
      expect((await new IntentDb(world.db).list()).map((r) => r.id)).toEqual([i.id]);
    });
    await vi.waitFor(() => {
      expect(server.issues.get(1)?.labels.has(2)).toBe(true);
    });
    // Not delivered yet: the layer stays (no flicker back to the old value).
    expect(tab.overlay.size).toBe(1);
    const seen: number[][] = [];
    const off = autorun(() => {
      seen.push(issueLabelIds(tab.pool, tab.overlay, 1));
    });
    tab.deliver();
    await vi.waitFor(() => {
      expect(tab.overlay.size).toBe(0);
    });
    off();
    expect(seen.every((ids) => ids.includes(2))).toBe(true);
    expect([...server.runs.keys()]).toEqual([i.key]);
    expect(await new IntentDb(world.db).list()).toEqual([]);
    world.close();
  });

  test('offline: queued, not sent; sent after caught_up only (flush rule 1); the pending count follows', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const world = new World(server, 1);
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'issue.state', state: 'closed', base: 'open'});
    tab.intents.submit({...ref, kind: 'issue.title', title: 'Renamed', base: 'Issue 1'});
    await world.settle(20);
    expect(tab.intents.pending).toBe(2);
    expect(tab.intents.pendingOn(1)).toBe(2);
    expect(server.runs.size).toBe(0);
    // Back online, the socket connected but not caught up yet: still nothing.
    server.online = true;
    tab.state.connection = 'catching_up';
    await world.settle(10);
    expect(server.runs.size).toBe(0);
    tab.setConnection('live');
    await world.settle();
    expect(server.issues.get(1)?.state).toBe('closed');
    expect(server.issues.get(1)?.title).toBe('Renamed');
    expect(tab.intents.pending).toBe(0);
    expect(tab.intents.pendingOn(1)).toBe(0);
    world.close();
  });

  test('after a reload the stored queue is back in the overlay before anything is sent', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const world = new World(server, 1);
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'issue.state', state: 'closed', base: 'open'});
    await world.settle(10);
    world.crash(); // the tab closes; a new one opens (offline)
    const next = world.leader;
    if (!next) throw new Error('no leader');
    await next.intents.ready;
    expect(untracked(() => issueState(next.overlay, next.pool.model('Issue').get(1) as never))).toBe('closed');
    world.close();
  });

  test('retries keep the key and the request: lost answers, 503, 409 in flight; a 401 refreshes once', async () => {
    const server = new FakeForgejo();
    const s = scripted(server, [new TypeError('lost'), answer(503, {}, {'Retry-After': '0'}), answer(409, {message: 'in flight'}, {'Retry-After': '0'}), answer(401)]);
    const refresh = vi.fn(() => Promise.resolve('tok2'));
    const world = new World(server, 1, {fetch: s.fetch, refresh});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    const i = tab.intents.submit({...ref, kind: 'issue.assignee', userId: ALICE, add: true});
    await world.settle();
    expect(s.calls.length).toBe(5);
    expect(new Set(s.calls.map((c) => c.key))).toEqual(new Set([i.key]));
    expect(new Set(s.calls.map((c) => c.body)).size).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(server.issues.get(1)?.assignees.has(ALICE)).toBe(true);
    world.close();
  });

  test('signed out: the queue is held, not dropped (PLAN §4.9)', async () => {
    const server = new FakeForgejo();
    const world = new World(server, 1, {token: () => Promise.reject(new Error('signed out'))});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.intents.submit({...ref, kind: 'issue.state', state: 'closed', base: 'open'});
    await world.settle(30);
    expect(tab.intents.pending).toBe(1);
    expect(tab.intents.drafts.size).toBe(0);
    expect(server.runs.size).toBe(0);
    world.close();
  });

  test('refused (4xx): the layer goes, the intent and its text become a draft in the same transaction; retry sends it again under a new key', async () => {
    const server = new FakeForgejo();
    const s = scripted(server, [answer(403, {message: 'You are not allowed.'})]);
    const failed = vi.fn();
    const world = new World(server, 1, {fetch: s.fetch, onFailed: failed});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    const i = tab.intents.submit({...ref, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'my words'});
    await world.settle();
    expect(tab.overlay.size).toBe(0);
    expect(failed).toHaveBeenCalledTimes(1);
    const drafts = await new IntentDb(world.db).drafts();
    expect(drafts.map((d) => [d.key, d.text, d.reason])).toEqual([[`failed:${i.id}`, 'my words', 'You are not allowed.']]);
    expect(await new IntentDb(world.db).list()).toEqual([]);
    const again = tab.intents.retry(`failed:${i.id}`);
    expect(again?.key).not.toBe(i.key);
    await world.settle();
    expect([...server.comments.values()].map((c) => c.body)).toEqual(['my words']);
    expect(await new IntentDb(world.db).drafts()).toEqual([]);
    world.close();
  });

  test('removing what is already gone (404) is done, not failed', async () => {
    const server = new FakeForgejo();
    const s = scripted(server, [answer(404)]);
    const world = new World(server, 1, {fetch: s.fetch});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    server.remote({t: 'label', issue: 1, label: 3, add: true});
    tab.deliver();
    tab.intents.submit({...ref, kind: 'issue.label', labelId: 3, add: false, drop: []});
    await world.settle();
    expect(tab.intents.drafts.size).toBe(0);
    expect(tab.intents.pending).toBe(0);
    world.close();
  });

  test('a change the server already shows is not sent', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const world = new World(server, 1);
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'issue.label', labelId: 3, add: true, drop: []});
    server.remote({t: 'label', issue: 1, label: 3, add: true}); // someone else did the same
    server.online = true;
    tab.deliver();
    tab.setConnection('live');
    await world.settle();
    expect(server.runs.size).toBe(0);
    expect(tab.intents.pending).toBe(0);
    world.close();
  });

  test('intents of one issue are sent one after the other, in order; other issues do not wait', async () => {
    const server = new FakeForgejo();
    const order: string[] = [];
    const world = new World(server, 1, {fetch: (async (url: string, init?: RequestInit) => {
      order.push(`${url} ${typeof init?.body === 'string' ? init.body : ''}`);
      return server.fetch(url, init);
    }) as typeof fetch});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.intents.submit({...ref, kind: 'issue.title', title: 'A', base: 'Issue 1'});
    tab.intents.submit({...ref, kind: 'issue.title', title: 'B', base: 'A'});
    tab.intents.submit({issueId: 2, repoId: REPO, kind: 'issue.title', title: 'C', base: 'Issue 2'});
    await world.settle();
    const one = order.filter((o) => o.includes('/issues/1 '));
    expect(one).toEqual(['/api/v1/repos/dev/big/issues/1 {"title":"A"}', '/api/v1/repos/dev/big/issues/1 {"title":"B"}']);
    expect(server.issues.get(1)?.title).toBe('B');
    expect(server.issues.get(2)?.title).toBe('C');
    world.close();
  });
});

describe('conflict policies', () => {
  test('scalars: last writer wins, and overriding someone’s newer value is told with one-click undo', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const overridden = vi.fn();
    const world = new World(server, 1, {onOverride: overridden});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'issue.title', title: 'Mine', base: 'Issue 1'});
    server.remote({t: 'title', issue: 1, title: 'Theirs'});
    server.online = true;
    tab.deliver();
    tab.setConnection('live');
    await world.settle();
    expect(server.issues.get(1)?.title).toBe('Mine');
    expect(overridden).toHaveBeenCalledTimes(1);
    const o = tab.intents.overrides[0];
    expect(o).toMatchObject({issueId: 1, field: 'title', theirs: 'Theirs', mine: 'Mine'});
    tab.intents.undoOverride(o?.id ?? '');
    await world.settle();
    expect(server.issues.get(1)?.title).toBe('Theirs');
    expect(tab.intents.overrides.length).toBe(0);
    world.close();
  });

  test('body: a clean 3-way merge is sent under a new key with the server’s version', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const world = new World(server, 1);
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.setConnection('offline');
    const i = tab.intents.submit({...ref, kind: 'issue.body', text: 'one\ntwo\nthree\nmine', baseText: 'one\ntwo\nthree', baseVersion: 0});
    server.remote({t: 'body', issue: 1, at: 0, token: 'theirs'});
    server.online = true;
    tab.setConnection('live'); // not delivered: the server answers 409 with its text, which is merged
    await world.settle();
    expect(server.issues.get(1)?.body).toBe('theirs\none\ntwo\nthree\nmine');
    // Merged against the pool's text (or the 409's when the pool was behind), then sent under a new key.
    expect([...server.runs.keys()].at(-1)).not.toBe(i.key);
    expect(server.mismatches).toEqual([]);
    expect(untracked(() => issueBody(tab.pool, tab.overlay, 1)?.text)).toBe('theirs\none\ntwo\nthree\nmine');
    world.close();
  });

  test('body: a conflict parks the intent (nothing sent, the user’s text shows) until the user resolves it', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const conflicted = vi.fn();
    const world = new World(server, 1, {onConflict: conflicted});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'issue.body', text: 'one\nMINE\nthree', baseText: 'one\ntwo\nthree', baseVersion: 0});
    server.remote({t: 'body', issue: 1, at: 1, token: 'THEIRS'}); // one, THEIRS, two, three: touches the same spot
    server.online = true;
    tab.deliver();
    tab.setConnection('live');
    await world.settle();
    const parked = tab.intents.conflictOf('issue.body', 1);
    expect(parked?.state).toBe('parked');
    expect(parked?.conflict?.merged).toContain('<<<<<<< yours');
    expect(conflicted).toHaveBeenCalled();
    expect(untracked(() => issueBody(tab.pool, tab.overlay, 1)?.text)).toBe('one\nMINE\nthree');
    expect(server.issues.get(1)?.body).toBe('one\nTHEIRS\ntwo\nthree');
    tab.intents.resolve(parked?.id ?? '', 'one\nTHEIRS\nMINE\nthree');
    await world.settle();
    expect(server.issues.get(1)?.body).toBe('one\nTHEIRS\nMINE\nthree');
    expect(tab.intents.pending).toBe(0);
    world.close();
  });

  test('comment edit: updated_at changed meanwhile ⇒ parked for the user (no silent overwrite)', async () => {
    const server = new FakeForgejo();
    const world = new World(server, 1);
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.intents.submit({...ref, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'first'});
    await world.settle();
    const c = untracked(() => [...tab.pool.model('Comment').all()][0]?.data);
    if (!c) throw new Error('no comment');
    server.online = false;
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'comment.edit', commentId: c.id, text: 'first, edited', baseText: c.body, baseVersion: c.content_version, baseUpdated: c.updated_at});
    server.remote({t: 'comment', issue: 1, token: 'by-alice'});
    server.online = true;
    tab.deliver();
    tab.setConnection('live');
    await world.settle();
    const parked = tab.intents.conflictOf('comment.edit', c.id);
    expect(parked?.conflict?.theirs).toBe('first by-alice');
    expect(server.comments.get(c.id)?.body).toBe('first by-alice');
    world.close();
  });

  test('creates: a comment on an issue created offline waits for it; the temporary ids are remapped (queue, views)', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const remaps = vi.fn();
    const world = new World(server, 1, {onRemap: remaps});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.setConnection('offline');
    const t = crypto.randomUUID();
    const temp = tempNum(t);
    tab.intents.submit({issueId: temp, repoId: REPO, kind: 'issue.create', tempId: t, title: 'Offline issue', body: 'b', labelIds: [1], assigneeIds: [], milestoneId: 0});
    tab.intents.submit({issueId: temp, repoId: REPO, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'on the new issue'});
    expect(untracked(() => tab.overlay.createdEntity('Issue', temp)?.data)).toMatchObject({title: 'Offline issue'});
    expect(untracked(() => issueComments(tab.pool, tab.overlay, temp, tab.intents.remapped).length)).toBe(1);
    server.online = true;
    tab.setConnection('live');
    await world.settle();
    const created = [...server.issues.values()].find((s) => s.title === 'Offline issue');
    expect(created).toBeDefined();
    expect([...server.comments.values()].map((c) => [c.issueId, c.body])).toEqual([[created?.id, 'on the new issue']]);
    expect(remaps).toHaveBeenCalledWith(expect.objectContaining({model: 'Issue', from: temp, to: created?.id}));
    expect(tab.intents.remapped.get(temp)).toBe(created?.id);
    expect(tab.overlay.size).toBe(0);
    world.close();
  });

  test('a create that fails takes what depends on it to the drafts too', async () => {
    const server = new FakeForgejo();
    const s = scripted(server, [answer(422, {message: 'title is required'})]);
    const world = new World(server, 1, {fetch: s.fetch});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    const t = crypto.randomUUID();
    tab.intents.submit({issueId: tempNum(t), repoId: REPO, kind: 'issue.create', tempId: t, title: '', body: '', labelIds: [], assigneeIds: [], milestoneId: 0});
    tab.intents.submit({issueId: tempNum(t), repoId: REPO, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'keep me'});
    await world.settle();
    expect(tab.intents.pending).toBe(0);
    expect([...tab.intents.drafts.values()].map((d) => d.text).sort()).toEqual(['', 'keep me']);
    world.close();
  });

  test('group_revoked: the group’s intents fail and their text is kept as drafts', async () => {
    const server = new FakeForgejo();
    server.online = false;
    let revoke: ((g: string) => void) | undefined;
    const world = new World(server, 1, {onRevoked: (fn) => {
      revoke = fn;
      return () => undefined;
    }});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'words'});
    await world.settle(10);
    revoke?.(`repo:${String(REPO)}`);
    await world.settle(10);
    expect(tab.intents.pending).toBe(0);
    expect([...tab.intents.drafts.values()].map((d) => [d.text, d.reason])).toEqual([['words', 'You no longer have access to this.']]);
    world.close();
  });

  test('a draft made after the names left the pool (a revoked repository) still names what it was', async () => {
    const server = new FakeForgejo();
    server.online = false;
    let revoke: ((g: string) => void) | undefined;
    let known = true;
    const world = new World(server, 1, {
      onRevoked: (fn) => {
        revoke = fn;
        return () => undefined;
      },
      names: () => ({label: (id) => (known && id === 2 ? 'security' : '')}),
    });
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'issue.label', labelId: 2, add: true, drop: []});
    await world.settle(10);
    known = false; // the purge took the labels with it
    revoke?.(`repo:${String(REPO)}`);
    await world.settle(10);
    expect([...tab.intents.drafts.values()].map((d) => d.title)).toEqual(['Adding the label “security”']);
    world.close();
  });
});

describe('tabs', () => {
  test('a follower stores its intent and the leader sends it; both drop the layer once their pool holds it', async () => {
    const server = new FakeForgejo();
    const world = new World(server, 2);
    const [leader, follower] = world.tabs;
    if (!leader || !follower) throw new Error('no tabs');
    follower.intents.submit({...ref, kind: 'issue.state', state: 'closed', base: 'open'});
    expect(untracked(() => issueState(follower.overlay, follower.pool.model('Issue').get(1) as never))).toBe('closed');
    await vi.waitFor(() => {
      expect(leader.overlay.size).toBe(1); // announced to the leader
    });
    await world.settle();
    expect(server.issues.get(1)?.state).toBe('closed');
    expect(follower.overlay.size + leader.overlay.size).toBe(0);
    world.close();
  });

  test('a follower’s discard is done by the leader (it knows what is in flight)', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const world = new World(server, 2);
    const [, follower] = world.tabs;
    if (!follower) throw new Error('no tabs');
    for (const t of world.tabs) t.setConnection('offline');
    const i = follower.intents.submit({...ref, kind: 'issue.state', state: 'closed', base: 'open'});
    await world.settle(10);
    const result = follower.intents.discard(i.id);
    await world.settle(10);
    expect(await result).toBe('discarded');
    expect(follower.intents.pending).toBe(0);
    expect(await new IntentDb(world.db).list()).toEqual([]);
    world.close();
  });

  test('a follower’s discard of an intent in flight is refused: not reported as discarded, sent once', async () => {
    const server = new FakeForgejo();
    let open: () => void = () => undefined;
    server.gate = new Promise((resolve) => {
      open = resolve;
    });
    const world = new World(server, 2);
    const [leader, follower] = world.tabs;
    if (!leader || !follower) throw new Error('no tabs');
    const i = follower.intents.submit({...ref, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'once'});
    await vi.waitFor(() => {
      expect(leader.intents.records.has(i.id)).toBe(true);
    });
    await new Promise((r) => setTimeout(r, 20)); // the leader is sending it (held at the gate)
    const result = follower.intents.discard(i.id);
    expect(await result).toBe('sending');
    server.gate = undefined;
    open();
    await world.settle();
    expect([...server.comments.values()].filter((c) => c.body === 'once')).toHaveLength(1);
    world.close();
  });

  test('the leader dies mid-flush (answer lost): the next leader sends it again under the same key — one comment', async () => {
    const server = new FakeForgejo();
    const world = new World(server, 2);
    const [leader, follower] = world.tabs;
    if (!leader || !follower) throw new Error('no tabs');
    server.lose = 1;
    const i = follower.intents.submit({...ref, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'once'});
    await vi.waitFor(() => {
      expect(server.runs.get(i.key)).toBe(1);
    });
    world.crash();
    await world.settle();
    expect([...server.comments.values()].map((c) => c.body)).toEqual(['once']);
    expect(server.runs.get(i.key)).toBe(1);
    expect(follower.overlay.size).toBe(0);
    world.close();
  });
});

describe('views', () => {
  test('a created comment does not show twice once its server copy arrived', () => {
    const w = poolWorld();
    const t = crypto.randomUUID();
    const i = newIntent({issueId: 7, repoId: 10, kind: 'comment.create', tempId: t, body: 'x'});
    w.overlay.add(i.id, intentOps(i, {userId: 1}));
    const remapped = new Map([[tempNum(t), 501]]);
    expect(issueComments(w.pool, w.overlay, 7, remapped).map((c) => c.id)).toEqual([tempNum(t)]);
    w.pool.batch(() => w.pool.put('Comment', 501, 'issue:7', ++v, comment(501, 7, 'x')));
    expect(issueComments(w.pool, w.overlay, 7, remapped).map((c) => c.id)).toEqual([501]);
  });

  test('titles and assignees read through the overlay', () => {
    const w = poolWorld();
    const i = newIntent({issueId: 7, repoId: 10, kind: 'issue.title', title: 'Local', base: 'Crash'});
    w.overlay.add(i.id, intentOps(i));
    const e = w.pool.model('Issue').get(7);
    if (!e) throw new Error('no issue');
    expect(issueTitle(w.overlay, e)).toBe('Local');
    expect(issueAssigneeIds(w.pool, w.overlay, 7)).toEqual([DEV]);
  });
});

describe('RUM (PLAN §5.8)', () => {
  test('a mutation reports localApplied → acked → confirmed and the queue\'s outcomes', async () => {
    takeCollected();
    const server = new FakeForgejo();
    const s = scripted(server, [answer(503, {}, {'Retry-After': '0'})]);
    const world = new World(server, 1, {fetch: s.fetch});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.intents.submit({...ref, kind: 'issue.label', labelId: 2, add: true, drop: []});
    await world.settle();
    tab.deliver();
    await vi.waitFor(() => {
      expect(tab.overlay.size).toBe(0);
    });
    await new Promise((r) => requestAnimationFrame(r));
    const got = takeCollected();
    expect(got.samples.get('mutationLocal')).toHaveLength(1);
    expect(got.samples.get('mutationAcked')).toHaveLength(1);
    expect(got.samples.get('mutationConfirmed')).toHaveLength(1);
    const [acked] = got.samples.get('mutationAcked') ?? [];
    const [confirmed] = got.samples.get('mutationConfirmed') ?? [];
    expect(confirmed).toBeGreaterThanOrEqual(acked ?? Infinity);
    expect(Object.fromEntries(got.counts)).toEqual({intentRetried: 1, intentFlushed: 1});
    expect(got.queueMax).toBe(1);
    world.close();
  });

  test('an intent queued offline gives no acked/confirmed timing (queue time is not the server\'s)', async () => {
    takeCollected();
    const server = new FakeForgejo();
    const world = new World(server, 1);
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'issue.label', labelId: 2, add: true, drop: []});
    await world.settle(10);
    await new Promise((r) => setTimeout(r, 1100));
    tab.setConnection('live');
    await world.settle();
    tab.deliver();
    await vi.waitFor(() => {
      expect(tab.overlay.size).toBe(0);
    });
    const got = takeCollected();
    expect(got.counts.get('intentFlushed')).toBe(1);
    expect(got.samples.has('mutationAcked')).toBe(false);
    expect(got.samples.has('mutationConfirmed')).toBe(false);
    world.close();
  });

  test('a refused intent counts as failed', async () => {
    takeCollected();
    const server = new FakeForgejo();
    const s = scripted(server, [answer(403, {message: 'no'})]);
    const world = new World(server, 1, {fetch: s.fetch});
    const tab = world.tabs[0];
    if (!tab) throw new Error('no tab');
    tab.intents.submit({...ref, kind: 'issue.state', state: 'closed', base: 'open'});
    await world.settle();
    expect(takeCollected().counts.get('intentFailed')).toBe(1);
    world.close();
  });
});
