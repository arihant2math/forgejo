// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Regressions from the F5 data-integrity review: each scenario lost or stranded an intent.

import {untracked} from 'mobx';
import {describe, expect, test, vi} from 'vitest';
import {FakeForgejo, REPO} from '../test/fakeForgejo.ts';
import {World} from '../test/fakeTabs.ts';
import {tempNum} from './intents.ts';
import {IntentDb} from './store.ts';

const ref = {issueId: 1, repoId: REPO};

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error('missing');
  return x;
}

describe('review regressions (data integrity)', () => {
  test('R1: a body edit that reverts an earlier queued body edit is dropped as "already on the server"', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const world = new World(server, 1);
    const tab = must(world.tabs[0]);
    tab.setConnection('offline');
    const orig = 'one\ntwo\nthree';
    const b1 = 'ONE\ntwo\nthree';
    tab.intents.submit({...ref, kind: 'issue.body', text: b1, baseText: orig, baseVersion: 0});
    // The user changes their mind: back to the original (the editor showed b1, an unsynced edit: version -1).
    tab.intents.submit({...ref, kind: 'issue.body', text: orig, baseText: b1, baseVersion: -1});
    await new Promise((r) => setTimeout(r, 20));
    server.online = true;
    tab.setConnection('live');
    // No delivery yet: B1's echo has not reached this tab's pool when B2 is prepared.
    await vi.waitFor(() => { expect(tab.intents.pending).toBe(0); }, {timeout: 3000});
    tab.deliver();
    
    expect(server.issues.get(1)?.body).toBe(orig); // the user's last word
    world.close();
  });

  test('R2: an intent submitted with a temporary id after its create was acked waits forever', async () => {
    const server = new FakeForgejo();
    const world = new World(server, 1);
    const tab = must(world.tabs[0]);
    const t = crypto.randomUUID();
    const temp = tempNum(t);
    tab.intents.submit({issueId: temp, repoId: REPO, kind: 'issue.create', tempId: t, title: 'New', body: '', labelIds: [], assigneeIds: [], milestoneId: 0});
    await vi.waitFor(() => { expect(tab.intents.remapped.has(temp)).toBe(true); });
    // The issue page still shows the overlay's temporary issue (the server's copy has not arrived): the composer uses temp.
    tab.intents.submit({issueId: temp, repoId: REPO, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'hello'});
    await world.settle();
    await new Promise((r) => setTimeout(r, 500));
    await world.settle();
    
    expect(server.comments.size).toBe(1);
    world.close();
  });

  test('R3: an intent whose storing failed is forgotten by the next re-read (no draft)', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const world = new World(server, 1);
    const tab = must(world.tabs[0]);
    tab.setConnection('offline');
    await tab.intents.ready;
    await new Promise((r) => setTimeout(r, 50));
    const spy = vi.spyOn(IntentDb.prototype, 'add').mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'));
    tab.intents.submit({...ref, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'my long text'});
    await new Promise((r) => setTimeout(r, 20));
    spy.mockRestore();
    
    await tab.intents.reread(); // e.g. the tab comes back to the foreground (session.ts visibilitychange)
    
    expect(tab.intents.pending + tab.intents.drafts.size).toBe(1);
    world.close();
  });

  test('R4: the leader dies during a failed create\'s cascade: the dependents wait forever', async () => {
    const server = new FakeForgejo();
    let first = true;
    const fetch = async (u: string, i: RequestInit) => {
      if (first && u.endsWith('/issues')) { first = false; return new Response('{"message":"no"}', {status: 422}); }
      return server.fetch(u, i);
    };
    server.online = false;
    const world = new World(server, 1, {fetch: fetch as typeof globalThis.fetch});
    const tab = must(world.tabs[0]);
    tab.setConnection('offline');
    const t = crypto.randomUUID();
    const temp = tempNum(t);
    tab.intents.submit({issueId: temp, repoId: REPO, kind: 'issue.create', tempId: t, title: 'X', body: '', labelIds: [], assigneeIds: [], milestoneId: 0});
    tab.intents.submit({issueId: temp, repoId: REPO, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'keep me'});
    await new Promise((r) => setTimeout(r, 20));
    const orig = IntentDb.prototype.fail; // eslint-disable-line @typescript-eslint/unbound-method -- called with its instance below
    let n = 0;
    const spy = vi.spyOn(IntentDb.prototype, 'fail').mockImplementation(async function (this: IntentDb, id: string, d) {
      const ok = await orig.call(this, id, d);
      if (n++ === 0) world.crash(); // the tab closes right after the create's draft is committed
      return ok;
    });
    server.online = true;
    tab.setConnection('live');
    await world.settle();
    await new Promise((r) => setTimeout(r, 300));
    await world.settle();
    spy.mockRestore();
    const next = must(world.leader);
    
    expect(next.intents.pending).toBe(0);
    world.close();
  });

  test('R2b: a follower\'s dependent stored while the create is in flight is never remapped', async () => {
    const server = new FakeForgejo();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let sent = false;
    const fetch = async (u: string, i: RequestInit) => {
      if (u.endsWith('/issues') && i.method === 'POST') { sent = true; await gate; }
      return server.fetch(u, i);
    };
    const world = new World(server, 2, {fetch: fetch as typeof globalThis.fetch});
    const [leader, follower] = world.tabs as [NonNullable<typeof world.tabs[0]>, NonNullable<typeof world.tabs[0]>];
    const t = crypto.randomUUID();
    const temp = tempNum(t);
    // The follower's 'added' announcement is slow to reach the leader (it arrives after the ack).
    const ch = (follower.intents as unknown as {env: {channel: {post: (m: {t: string}) => void}}}).env.channel;
    const post = ch.post.bind(ch);
    const held: {t: string}[] = [];
    ch.post = (m) => { if (m.t === 'added') held.push(m); else post(m); };
    leader.intents.submit({issueId: temp, repoId: REPO, kind: 'issue.create', tempId: t, title: 'New', body: '', labelIds: [], assigneeIds: [], milestoneId: 0});
    await vi.waitFor(() => { expect(sent).toBe(true); });
    follower.intents.submit({issueId: temp, repoId: REPO, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'from the follower'});
    await vi.waitFor(async () => { expect((await new IntentDb(world.db).list()).length).toBe(2); });
    release();
    await vi.waitFor(() => { expect(leader.intents.remapped.has(temp)).toBe(true); });
    for (const m of held) post(m);
    await world.settle();
    await new Promise((r) => setTimeout(r, 400));
    await world.settle();
    
    expect(server.comments.size).toBe(1);
    world.close();
  });

  test('R5: one transient token error (network, not signed out) holds the queue until the socket reconnects', async () => {
    const server = new FakeForgejo();
    let n = 0;
    const world = new World(server, 1, {token: () => (n++ === 0 ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve('tok'))});
    const tab = must(world.tabs[0]);
    tab.intents.submit({...ref, kind: 'issue.state', state: 'closed', base: 'open'});
    await world.settle(60);
    tab.caughtUp(); // more caught_up events while live: still held
    tab.intents.submit({...ref, kind: 'issue.title', title: 'x', base: 'Issue 1'});
    await world.settle(60);
    
    expect(tab.intents.pending).toBe(0);
    world.close();
  });
});

describe('review regressions (conflict policy)', () => {
  /** Offline, then online with deltas arriving late (as in a browser). */
  async function lateOnline(world: World, server: FakeForgejo): Promise<void> {
    world.lag = 5;
    server.online = true;
    for (const t of world.alive()) t.setConnection('live');
    await world.settle();
  }

  test('M1: two offline edits of the description in a row: no false conflict, the last text wins', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const world = new World(server, 1);
    const tab = must(world.tabs[0]);
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'issue.body', text: 'one\nTWO-A\nthree', baseText: 'one\ntwo\nthree', baseVersion: 0});
    tab.intents.submit({...ref, kind: 'issue.body', text: 'one\nTWO-B\nthree', baseText: 'one\nTWO-A\nthree', baseVersion: -1});
    await lateOnline(world, server);
    expect(tab.intents.conflictOf('issue.body', 1)).toBeUndefined();
    expect(server.issues.get(1)?.body).toBe('one\nTWO-B\nthree');
    expect(tab.intents.pending).toBe(0);
    world.close();
  });

  test('M2: two offline edits of a comment in a row: no conflict with one’s own edit', async () => {
    const server = new FakeForgejo();
    const world = new World(server, 1);
    const tab = must(world.tabs[0]);
    tab.intents.submit({...ref, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'first'});
    await world.settle();
    const c = must(untracked(() => [...tab.pool.model('Comment').all()][0]?.data));
    server.online = false;
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'comment.edit', commentId: c.id, text: 'A', baseText: 'first', baseVersion: c.content_version, baseUpdated: c.updated_at});
    tab.intents.submit({...ref, kind: 'comment.edit', commentId: c.id, text: 'B', baseText: 'A', baseVersion: -1, baseUpdated: c.updated_at});
    await lateOnline(world, server);
    expect(tab.intents.conflictOf('comment.edit', c.id)).toBeUndefined();
    expect(server.comments.get(c.id)?.body).toBe('B');
    world.close();
  });

  test('M3: the override notice shows even when another intent of the issue went first', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const overridden = vi.fn();
    const world = new World(server, 1, {onOverride: overridden});
    const tab = must(world.tabs[0]);
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'issue.label', labelId: 2, add: true, drop: []});
    tab.intents.submit({...ref, kind: 'issue.title', title: 'Mine', base: 'Issue 1'});
    server.remote({t: 'title', issue: 1, title: 'Theirs'});
    await lateOnline(world, server);
    expect(server.issues.get(1)?.title).toBe('Mine');
    expect(overridden).toHaveBeenCalledTimes(1);
    world.close();
  });

  test('M4: a parked description conflict holds back only later description edits; deleting a comment drops its parked edit to the drafts', async () => {
    const server = new FakeForgejo();
    const world = new World(server, 1);
    const tab = must(world.tabs[0]);
    tab.intents.submit({...ref, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'first'});
    await world.settle();
    const c = must(untracked(() => [...tab.pool.model('Comment').all()][0]?.data));
    server.online = false;
    tab.setConnection('offline');
    tab.intents.submit({...ref, kind: 'issue.body', text: 'one\nMINE\nthree', baseText: 'one\ntwo\nthree', baseVersion: 0});
    tab.intents.submit({...ref, kind: 'comment.edit', commentId: c.id, text: 'mine', baseText: 'first', baseVersion: c.content_version, baseUpdated: c.updated_at});
    server.remote({t: 'body', issue: 1, at: 1, token: 'THEIRS'});
    server.remote({t: 'comment', issue: 1, token: 'theirs'});
    tab.intents.submit({...ref, kind: 'issue.title', title: 'Renamed', base: 'Issue 1'});
    tab.intents.submit({...ref, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'second'});
    server.online = true;
    tab.deliver();
    tab.setConnection('live');
    await world.settle();
    expect(tab.intents.conflictOf('issue.body', 1)).toBeDefined();
    expect(tab.intents.conflictOf('comment.edit', c.id)).toBeDefined();
    expect(server.issues.get(1)?.title).toBe('Renamed');
    expect([...server.comments.values()].map((x) => x.body)).toContain('second');
    tab.intents.submit({...ref, kind: 'comment.delete', commentId: c.id});
    await world.settle();
    expect(server.comments.get(c.id)?.deleted).toBe(true);
    expect([...tab.intents.drafts.values()].map((d) => d.text)).toContain('mine');
    expect(tab.intents.pending).toBe(1); // the description conflict, for the user
    world.close();
  });

  test('M5: discarding a create sends what depends on it to the drafts; the issue’s other changes go on', async () => {
    const server = new FakeForgejo();
    server.online = false;
    const world = new World(server, 1);
    const tab = must(world.tabs[0]);
    tab.setConnection('offline');
    const t = crypto.randomUUID();
    const created = tab.intents.submit({...ref, kind: 'comment.create', tempId: t, body: 'draft-ish'});
    tab.intents.submit({...ref, kind: 'comment.edit', commentId: tempNum(t), text: 'edited', baseText: 'draft-ish', baseVersion: -1, baseUpdated: ''});
    tab.intents.submit({...ref, kind: 'issue.title', title: 'Renamed', base: 'Issue 1'});
    await world.settle(20);
    tab.intents.discard(created.id);
    await lateOnline(world, server);
    expect(server.issues.get(1)?.title).toBe('Renamed');
    expect(server.comments.size).toBe(0);
    expect(tab.intents.pending).toBe(0);
    expect([...tab.intents.drafts.values()].map((d) => d.text)).toEqual(['edited']);
    world.close();
  });

  test('M6: retrying a create’s dependent before the create does not deadlock', async () => {
    const server = new FakeForgejo();
    let refuse = true;
    const fetch = async (u: string, i: RequestInit) => {
      if (refuse && u.endsWith('/issues') && i.method === 'POST') {
        refuse = false;
        return new Response('{"message":"no"}', {status: 422});
      }
      return server.fetch(u, i);
    };
    const world = new World(server, 1, {fetch: fetch as typeof globalThis.fetch});
    const tab = must(world.tabs[0]);
    const t = crypto.randomUUID();
    const temp = tempNum(t);
    tab.intents.submit({issueId: temp, repoId: REPO, kind: 'issue.create', tempId: t, title: 'X', body: '', labelIds: [], assigneeIds: [], milestoneId: 0});
    tab.intents.submit({issueId: temp, repoId: REPO, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'on it'});
    await world.settle();
    expect(tab.intents.drafts.size).toBe(2);
    const drafts = [...tab.intents.drafts.values()];
    const comment = must(drafts.find((d) => d.intent?.kind === 'comment.create'));
    const issue = must(drafts.find((d) => d.intent?.kind === 'issue.create'));
    tab.intents.retry(comment.key);
    tab.intents.retry(issue.key);
    await world.settle();
    expect(tab.intents.pending).toBe(0);
    expect([...server.comments.values()].map((x) => x.body)).toEqual(['on it']);
    world.close();
  });

  test('M9: the remap survives a reload (a later tab maps the temporary id; a late intent under it is sent)', async () => {
    const server = new FakeForgejo();
    const world = new World(server, 1);
    const tab = must(world.tabs[0]);
    const t = crypto.randomUUID();
    const temp = tempNum(t);
    tab.intents.submit({issueId: temp, repoId: REPO, kind: 'issue.create', tempId: t, title: 'New', body: '', labelIds: [], assigneeIds: [], milestoneId: 0});
    await world.settle();
    world.crash();
    const next = must(world.leader);
    await next.intents.ready;
    const real = next.intents.remapped.get(temp);
    expect(real).toBeGreaterThan(0);
    next.intents.submit({issueId: temp, repoId: REPO, kind: 'comment.create', tempId: crypto.randomUUID(), body: 'late'});
    await world.settle();
    expect([...server.comments.values()].map((x) => [x.issueId, x.body])).toEqual([[real, 'late']]);
    world.close();
  });
});
