// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The sync client against a scripted server: a fake WebSocket / EventSource
// and a fake fetch that serves NDJSON bootstraps.

import {afterEach, describe, expect, test, vi} from 'vitest';
import {MetaCache} from '../data/meta.ts';
import {clientSchemas} from '../data/models.ts';
import {Pool} from '../data/pool.ts';
import type {ServerMessage} from '../protocol/types.gen.ts';
import {SyncClient, type SyncClientOptions} from './client.ts';
import {FakeES, FakeWS, issueChange, NOW, Server} from '../test/fakeSync.ts';

function welcome(extra: Partial<Extract<ServerMessage, {type: 'welcome'}>> = {}): ServerMessage {
  return {
    type: 'welcome', server_sync_id: 10, viewer_id: 1, granted: [], refused: [], grants: [], build_id: 'b', protocol: 1,
    schemas: clientSchemas(), ...extra,
  };
}

const clients: SyncClient[] = [];

function setup(opts: {meta?: MetaCache; server?: Server; refresh?: () => Promise<string | null>; transport?: 'auto' | 'ws' | 'sse'; extra?: Partial<SyncClientOptions>} = {}) {
  FakeWS.all = [];
  FakeES.all = [];
  const server = opts.server ?? new Server();
  const pool = new Pool();
  const meta = opts.meta ?? new MetaCache();
  const persister = {schedule: vi.fn(), flush: vi.fn(() => Promise.resolve()), clearModels: vi.fn(), dropGroups: vi.fn()};
  const refresh = vi.fn(opts.refresh ?? (() => Promise.resolve('tok')));
  const c = new SyncClient({
    pool, meta, persister, userId: 1, auth: {token: () => Promise.resolve('tok'), refresh}, endpoint: '/-/sync', backoffBase: 1,
    transport: opts.transport ?? 'auto',
    env: {WebSocket: FakeWS as unknown as typeof WebSocket, EventSource: FakeES as unknown as typeof EventSource, fetch: server.fetch, base: 'http://x/'},
    ...opts.extra,
  });
  clients.push(c);
  return {c, pool, meta, server, persister, refresh, ws: () => FakeWS.latest()};
}

afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

async function connected(t: ReturnType<typeof setup>): Promise<FakeWS> {
  t.c.start();
  await vi.waitFor(() => {
    expect(FakeWS.all.length).toBeGreaterThan(0);
  });
  const ws = t.ws();
  ws.open();
  await vi.waitFor(() => {
    expect(ws.last('hello')).toBeDefined();
  });
  return ws;
}

describe('first session', () => {
  test('workspace → bootstrap → subscribe from the watermark → live deltas', async () => {
    const t = setup();
    t.server.workspace.groups = [{group: 'repo:1', units: ['issues'], reason: 'owner'}];
    t.server.boots.set('repo:1', [{watermark: 20, units: ['issues'], lines: [issueChange(1, 20, 'a'), issueChange(2, 20, 'b')], refs: ['profiles:public']}]);
    t.server.boots.set('profiles:public', [{watermark: 21, lines: [{v: 21, g: 'profiles:public', m: 'User', id: 5, op: 'U', d: {id: 5, login: 'u5'}}]}]);
    const ws = await connected(t);
    expect(ws.url).toBe('ws://x/-/sync/ws');
    expect(ws.last('hello')).toMatchObject({token: 'tok', protocol: 1, groups: []});
    ws.emit(welcome());
    await vi.waitFor(() => {
      expect(ws.sent.filter((m) => m.type === 'subscribe').map((m) => m.groups)).toEqual(expect.arrayContaining([
        [{group: 'repo:1', since: 20}], [{group: 'profiles:public', since: 21}],
      ]));
    });
    expect(t.pool.model('Issue').size).toBe(2);
    expect(t.pool.model('User').get(5)?.get('login')).toBe('u5');
    expect(t.c.groups.get('repo:1')).toMatchObject({position: 20, units: ['issues'], watermark: 20, refs: ['profiles:public'], holders: ['workspace']});
    expect(t.c.isHeld('profiles:public')).toBe(true);
    expect(t.c.status.connection).toBe('catching_up');

    ws.grantSubscribes({'repo:1': ['issues']});
    ws.emit({type: 'caught_up', sync_id: 25});
    expect(t.c.status.connection).toBe('live');
    expect(t.c.groups.get('repo:1')?.position).toBe(25);
    ws.emit({type: 'delta', to: 30, changes: [issueChange(1, 28, 'a2'), {v: 29, g: 'repo:1', m: 'Issue', id: 2, op: 'D'}]});
    expect(t.pool.model('Issue').get(1)?.get('title')).toBe('a2');
    expect(t.pool.model('Issue').get(2)).toBeUndefined();
    expect(t.c.groups.get('repo:1')?.position).toBe(30);
    // A delta of a group this session does not hold is ignored.
    ws.emit({type: 'delta', to: 31, changes: [issueChange(9, 31, 'x', 'repo:9')]});
    expect(t.pool.model('Issue').get(9)).toBeUndefined();
  });
});

describe('resume', () => {
  function heldMeta(): MetaCache {
    const meta = new MetaCache();
    meta.set('group:repo:1', {group: 'repo:1', position: 50, units: ['issues'], watermark: 40, tier: 'summary', holders: ['workspace']});
    meta.set('schemas', clientSchemas());
    return meta;
  }

  test('hello resumes held groups from their positions; positions rise only once caught up', async () => {
    const t = setup({meta: heldMeta()});
    t.server.workspace.groups = [{group: 'repo:1', units: ['issues'], reason: 'owner'}];
    const ws = await connected(t);
    expect(ws.last('hello')?.groups).toEqual([{group: 'repo:1', since: 50}]);
    ws.emit(welcome({granted: [{group: 'repo:1', units: ['issues']}]}));
    ws.emit({type: 'delta', to: 60, changes: [issueChange(1, 55, 'a')]});
    expect(t.c.groups.get('repo:1')?.position).toBe(55); // the change's v, not `to`: not caught up yet
    ws.emit({type: 'caught_up', sync_id: 60});
    expect(t.c.groups.get('repo:1')?.position).toBe(60);
    ws.emit({type: 'pong', sync_id: 70});
    expect(t.c.groups.get('repo:1')?.position).toBe(70);
    expect(t.server.requests.filter((r) => r.includes('bootstrap'))).toEqual([]);
  });

  test('the units rule: a grant with other units re-bootstraps the whole group', async () => {
    const t = setup({meta: heldMeta()});
    t.server.workspace.groups = [{group: 'repo:1', units: ['issues'], reason: 'owner'}];
    t.server.boots.set('repo:1', [{watermark: 80, units: ['issues', 'pulls'], lines: [issueChange(3, 80, 'c')]}]);
    const ws = await connected(t);
    t.pool.batch(() => t.pool.put('Issue', 1, 'repo:1', 45, {id: 1, repo_id: 1, title: 'held', state: 'closed', updated_at: '2020-01-01T00:00:00Z'} as never));
    ws.emit(welcome({granted: [{group: 'repo:1', units: ['issues', 'pulls']}]}));
    await vi.waitFor(() => {
      expect(t.c.groups.get('repo:1')?.units).toEqual(['issues', 'pulls']);
    });
    expect(t.server.requests.find((r) => r.includes('bootstrap'))).toBe('/-/sync/bootstrap?group=repo%3A1');
    // Units changed: even the closed tier went.
    expect(t.pool.model('Issue').get(1)).toBeUndefined();
    expect(t.c.groups.get('repo:1')?.needs).toBeUndefined();
    expect(t.c.groups.get('repo:1')?.position).toBe(80);
  });

  test('bootstrap_required{model} reloads that model only, without raising the position', async () => {
    const t = setup({meta: heldMeta()});
    t.server.workspace.groups = [{group: 'repo:1', units: ['issues'], reason: 'owner'}];
    t.server.boots.set('repo:1', [{watermark: 90, units: ['issues'], lines: [{v: 90, g: 'repo:1', m: 'Label', id: 4, op: 'U', d: {id: 4, repo_id: 1}}]}]);
    const ws = await connected(t);
    ws.emit(welcome({granted: [{group: 'repo:1', units: ['issues']}]}));
    t.pool.batch(() => {
      t.pool.put('Label', 3, 'repo:1', 30, {id: 3, repo_id: 1} as never);
      t.pool.put('Issue', 1, 'repo:1', 30, {id: 1, repo_id: 1, state: 'open', updated_at: NOW} as never);
    });
    ws.emit({type: 'bootstrap_required', group: 'repo:1', reason: 'trigger_repaired', model: 'Label'});
    await vi.waitFor(() => {
      expect(t.c.groups.get('repo:1')?.needs).toBeUndefined();
    });
    expect(t.server.requests.find((r) => r.includes('bootstrap'))).toBe('/-/sync/bootstrap?group=repo%3A1&model=Label');
    expect([...t.pool.model('Label').all()].map((e) => e.id)).toEqual([4]);
    expect(t.pool.model('Issue').get(1)).toBeDefined();
    expect(t.c.groups.get('repo:1')?.position).toBe(50);
  });

  test('a need survives until a bootstrap covering it completed (persisted)', async () => {
    const meta = heldMeta();
    const t = setup({meta});
    t.server.workspace.groups = [{group: 'repo:1', units: ['issues'], reason: 'owner'}];
    t.server.boots.set('repo:1', [{watermark: 0, incomplete: true}]);
    const ws = await connected(t);
    ws.emit(welcome({granted: [{group: 'repo:1', units: ['issues']}]}));
    ws.emit({type: 'bootstrap_required', group: 'repo:1', reason: 'cursor_trimmed'});
    await vi.waitFor(() => {
      expect(t.c.status.lastError).toMatch(/incomplete/);
    });
    expect(meta.get<{needs?: unknown}>('group:repo:1')?.needs).toEqual({all: true, models: [], reason: 'cursor_trimmed'});
  });
});

describe('revocation and release', () => {
  test('group_revoked purges the group and its state', async () => {
    const t = setup();
    t.server.workspace.groups = [{group: 'repo:1', units: ['issues'], reason: 'owner'}];
    t.server.boots.set('repo:1', [{watermark: 20, lines: [issueChange(1, 20, 'a')]}]);
    const revoked: string[] = [];
    t.c.on('revoked', (e) => revoked.push(e.group));
    const ws = await connected(t);
    ws.emit(welcome());
    await vi.waitFor(() => {
      expect(t.pool.model('Issue').size).toBe(1);
    });
    ws.emit({type: 'group_revoked', group: 'repo:1'});
    expect(t.pool.model('Issue').size).toBe(0);
    expect(t.c.groups.get('repo:1')).toBeUndefined();
    expect(t.c.isHeld('repo:1')).toBe(false);
    expect(revoked).toEqual(['repo:1']);
    // A frame of the group still in flight cannot bring it back.
    ws.emit({type: 'delta', to: 21, changes: [issueChange(1, 21, 'late')]});
    expect(t.pool.model('Issue').size).toBe(0);
  });

  test('a 404 bootstrap revokes; a refused subscription revokes', async () => {
    const t = setup();
    t.server.workspace.groups = [{group: 'repo:1', units: [], reason: 'owner'}, {group: 'repo:2', units: [], reason: 'owner'}];
    t.server.boots.set('repo:2', [{watermark: 5}]);
    const revoked: string[] = [];
    t.c.on('revoked', (e) => revoked.push(e.group));
    const ws = await connected(t);
    ws.emit(welcome());
    await vi.waitFor(() => {
      expect(revoked).toEqual(['repo:1']);
    });
    await vi.waitFor(() => {
      expect(ws.last('subscribe')).toBeDefined();
    });
    ws.emit({type: 'subscribed', granted: [], refused: [{group: 'repo:2', reason: 'forbidden'}]});
    expect(revoked).toEqual(['repo:1', 'repo:2']);
  });

  test('tab holds: on-demand groups stay "recent"; releasing a root releases its refs', async () => {
    const t = setup();
    t.server.boots.set('issue:7', [{watermark: 30, lines: [{v: 30, g: 'issue:7', m: 'Comment', id: 1, op: 'U', d: {id: 1, issue_id: 7}}], refs: ['profile:9']}]);
    t.server.boots.set('profile:9', [{watermark: 31}]);
    const ws = await connected(t);
    ws.emit(welcome());
    t.c.hold('issue:7', 'tab:a');
    await vi.waitFor(() => {
      expect(t.c.isHeld('profile:9')).toBe(true);
    });
    expect(t.server.requests).toContain('/-/sync/load?group=issue%3A7');
    t.c.release('issue:7', 'tab:a');
    expect(t.c.isHeld('issue:7')).toBe(true); // recent
    // Pinned, then unpinned: still "recent" until the LRU drops it.
    t.c.pin('issue:7', true);
    expect(t.c.groups.get('issue:7')?.holders).toEqual(['recent', 'pin']);
    t.c.pin('issue:7', false);
    expect(t.c.isHeld('issue:7')).toBe(true);
    // The LRU: a cap of 0 issue groups drops it at the next hold.
    (t.c as unknown as {o: {recentCaps: Record<string, number>}}).o.recentCaps = {issue: 0};
    t.c.hold('repo:3', 'tab:b');
    expect(t.c.isHeld('issue:7')).toBe(false);
    expect(t.c.isHeld('profile:9')).toBe(false);
    expect(t.pool.model('Comment').size).toBe(0);
    expect(ws.sent.filter((m) => m.type === 'unsubscribe').flatMap((m) => m.groups as string[])).toEqual(expect.arrayContaining(['issue:7', 'profile:9']));
  });

  test('an Issue that is dropped releases its issue group', async () => {
    const t = setup();
    t.server.workspace.groups = [{group: 'repo:1', units: [], reason: 'owner'}];
    t.server.boots.set('repo:1', [{watermark: 20, lines: [issueChange(7, 20, 'a')]}]);
    t.server.boots.set('issue:7', [{watermark: 21, lines: [{v: 21, g: 'issue:7', m: 'IssueBody', id: 7, op: 'U', d: {id: 7, body: 'x'}}]}]);
    const dropped: number[] = [];
    t.c.on('issueDropped', (e) => dropped.push(e.issueId));
    const ws = await connected(t);
    ws.emit(welcome());
    t.c.hold('issue:7', 'tab:a');
    await vi.waitFor(() => {
      expect(t.pool.model('IssueBody').size).toBe(1);
    });
    await vi.waitFor(() => {
      expect(t.pool.model('Issue').size).toBe(1);
    });
    ws.grantSubscribes();
    // A move (D + U in one frame) is not a drop.
    ws.emit({type: 'delta', to: 23, changes: [{v: 22, g: 'repo:1', m: 'Issue', id: 7, op: 'D'}, {...issueChange(7, 23, 'moved'), g: 'repo:1'}]});
    expect(t.c.isHeld('issue:7')).toBe(true);
    ws.emit({type: 'delta', to: 24, changes: [{v: 24, g: 'repo:1', m: 'Issue', id: 7, op: 'D'}]});
    expect(dropped).toEqual([7]);
    expect(t.c.isHeld('issue:7')).toBe(false);
    expect(t.pool.model('IssueBody').size).toBe(0);
  });
});

describe('connection', () => {
  test('session_invalid refreshes the token and reconnects; null means signed out', async () => {
    let n = 0;
    const t = setup({refresh: () => Promise.resolve(++n === 1 ? 'tok' : null)});
    const ws = await connected(t);
    ws.emit({type: 'session_invalid', message: 'token expired'});
    await vi.waitFor(() => {
      expect(FakeWS.all.length).toBe(2);
    });
    const ws2 = t.ws();
    ws2.open();
    await vi.waitFor(() => {
      expect(ws2.last('hello')).toBeDefined();
    });
    ws2.emit({type: 'session_invalid', message: 'revoked'});
    await vi.waitFor(() => {
      expect(t.c.status.connection).toBe('unauthorized');
    });
    expect(t.refresh).toHaveBeenCalledTimes(2);
  });

  test('reconnects after a drop and resumes; falls back to SSE after two failed opens', async () => {
    const meta = new MetaCache();
    meta.set('group:user:1', {group: 'user:1', position: 7, units: ['self'], watermark: 7, holders: ['workspace']});
    const t = setup({meta});
    t.server.workspace.groups = [{group: 'user:1', units: ['self'], reason: 'self'}];
    const ws = await connected(t);
    ws.emit(welcome({granted: [{group: 'user:1', units: ['self']}]}));
    ws.emit({type: 'resume_from_cursor', sync_id: 3});
    await vi.waitFor(() => {
      expect(FakeWS.all.length).toBe(2);
    });
    t.ws().close(1006); // never opened
    await vi.waitFor(() => {
      expect(FakeWS.all.length).toBe(3);
    });
    t.ws().close(1006);
    await vi.waitFor(() => {
      expect(FakeES.all.length).toBe(1);
    });
    const es = FakeES.all[0];
    if (!es) throw new Error('no EventSource');
    expect(es.url).toBe('http://x/-/sync/sse');
    es.emit({type: 'session', session: 's1'});
    await vi.waitFor(() => {
      expect(t.server.requests).toContain('http://x/-/sync/send');
    });
    expect(t.c.status.transport).toBe('sse');
  });

  test('a missing pong closes the session', async () => {
    const t = setup({extra: {pingInterval: 5, pongTimeout: 5}});
    const ws = await connected(t);
    ws.emit(welcome());
    await vi.waitFor(() => {
      expect(ws.last('ping')).toBeDefined();
    });
    await vi.waitFor(() => {
      expect(FakeWS.all.length).toBe(2);
    });
  });

  test('barrier resolves with barrier_ok and raises caught-up positions', async () => {
    const meta = new MetaCache();
    meta.set('group:user:1', {group: 'user:1', position: 7, units: ['self'], watermark: 7, holders: ['workspace']});
    const t = setup({meta});
    t.server.workspace.groups = [{group: 'user:1', units: ['self'], reason: 'self'}];
    const ws = await connected(t);
    ws.emit(welcome({granted: [{group: 'user:1', units: ['self']}]}));
    ws.emit({type: 'caught_up', sync_id: 8});
    const p = t.c.barrier();
    const id = ws.last('barrier')?.id as string;
    ws.emit({type: 'barrier_ok', id, sync_id: 12});
    await expect(p).resolves.toBe(12);
    expect(t.c.groups.get('user:1')?.position).toBe(12);
  });

  test('a 503 is retried after Retry-After', async () => {
    const t = setup();
    t.server.workspace.groups = [{group: 'user:1', units: ['self'], reason: 'self'}];
    t.server.boots.set('user:1', [{watermark: 0, status: 503, retryAfter: '0.01'}, {watermark: 9}]);
    const ws = await connected(t);
    ws.emit(welcome());
    await vi.waitFor(() => {
      expect(t.c.groups.get('user:1')?.position).toBe(9);
    });
    expect(t.server.requests.filter((r) => r.includes('bootstrap'))).toHaveLength(2);
  });

  test('the wrong user stops the client', async () => {
    const t = setup();
    const wrong: number[] = [];
    t.c.on('wrongUser', (e) => wrong.push(e.viewerId));
    const ws = await connected(t);
    ws.emit(welcome({viewer_id: 2}));
    expect(wrong).toEqual([2]);
    expect(t.c.status.connection).toBe('stopped');
  });
});

describe('schemas', () => {
  test('stored data of another schema is dropped and re-bootstrapped; a server mismatch is reported', async () => {
    const meta = new MetaCache();
    meta.set('schemas', {...clientSchemas(), Label: 0});
    meta.set('group:repo:1', {group: 'repo:1', position: 50, units: [], watermark: 40, holders: ['workspace']});
    meta.set('group:user:1', {group: 'user:1', position: 50, units: [], watermark: 40, holders: ['workspace']});
    const t = setup({meta});
    t.server.workspace.groups = [{group: 'repo:1', units: [], reason: 'owner'}, {group: 'user:1', units: [], reason: 'self'}];
    t.server.boots.set('repo:1', [{watermark: 60}]);
    const mismatch: string[][] = [];
    t.c.on('schemaMismatch', (e) => mismatch.push(e.models));
    const ws = await connected(t);
    expect(t.persister.clearModels).toHaveBeenCalledWith(['Label']);
    // Only the groups that can hold labels reload them (before the session even opened).
    await vi.waitFor(() => {
      expect(t.server.requests).toContain('/-/sync/bootstrap?group=repo%3A1&model=Label');
    });
    expect(t.server.requests.filter((r) => r.includes('user%3A1'))).toEqual([]);
    ws.emit(welcome({granted: [{group: 'repo:1', units: []}, {group: 'user:1', units: []}], schemas: {...clientSchemas(), Issue: 2}}));
    expect(mismatch).toEqual([['Issue']]);
    expect(t.persister.clearModels).toHaveBeenLastCalledWith(['Issue']);
    await vi.waitFor(() => {
      expect(t.server.requests).toContain('/-/sync/bootstrap?group=repo%3A1&model=Issue');
    });
  });
});

describe('review regressions', () => {
  test('a group released and held again at the same watermark comes back', async () => {
    const t = setup();
    t.server.boots.set('profiles:public', [{watermark: 30, lines: [{v: 30, g: 'profiles:public', m: 'User', id: 9, op: 'U', d: {id: 9, login: 'u9'}}]}]);
    const ws = await connected(t);
    ws.emit(welcome());
    t.c.hold('profiles:public', 'tab:a');
    await vi.waitFor(() => {
      expect(t.pool.model('User').get(9)).toBeDefined();
    });
    t.c.release('profiles:public', 'tab:a');
    t.c.groups.update('profiles:public', (x) => {
      x.holders = [];
    });
    t.c.hold('repo:99', 'tab:z'); // recompute
    expect(t.c.isHeld('profiles:public')).toBe(false);
    expect(t.pool.model('User').get(9)).toBeUndefined();
    expect(t.persister.dropGroups).toHaveBeenCalledWith(['profiles:public']);
    t.c.hold('profiles:public', 'tab:a');
    await vi.waitFor(() => {
      expect(t.pool.model('User').get(9)?.get('login')).toBe('u9');
    });
  });

  test('a schema change of Issue releases no issue group; the model reloads at the same watermark', async () => {
    const t = setup();
    t.server.workspace.groups = [{group: 'repo:1', units: [], reason: 'owner'}];
    t.server.boots.set('repo:1', [{watermark: 20, lines: [issueChange(7, 20, 'a')]}]);
    t.server.boots.set('issue:7', [{watermark: 20, lines: [{v: 20, g: 'issue:7', m: 'IssueBody', id: 7, op: 'U', d: {id: 7, body: 'x'}}]}]);
    const dropped: number[] = [];
    t.c.on('issueDropped', (e) => dropped.push(e.issueId));
    const ws = await connected(t);
    ws.emit(welcome());
    t.c.hold('issue:7', 'tab:a');
    await vi.waitFor(() => {
      expect(t.pool.model('IssueBody').size).toBe(1);
      expect(t.c.groups.get('repo:1')?.position).toBe(20);
    });
    ws.close(1006);
    await vi.waitFor(() => {
      expect(FakeWS.all.length).toBe(2);
    });
    const ws2 = FakeWS.latest();
    ws2.open();
    await vi.waitFor(() => {
      expect(ws2.last('hello')).toBeDefined();
    });
    ws2.emit(welcome({granted: [{group: 'repo:1', units: []}, {group: 'issue:7', units: []}], schemas: {...clientSchemas(), Issue: 99}}));
    await vi.waitFor(() => {
      expect(t.server.requests).toContain('/-/sync/bootstrap?group=repo%3A1&model=Issue');
      expect(t.c.groups.get('repo:1')?.needs).toBeUndefined();
    });
    expect(dropped).toEqual([]);
    expect(t.c.isHeld('issue:7')).toBe(true);
    expect(t.pool.model('Issue').get(7)).toBeDefined();
  });

  test('cursor_unknown forgets the group and loads it again', async () => {
    const meta = new MetaCache();
    meta.set('group:repo:1', {group: 'repo:1', position: 999, units: ['issues'], watermark: 999, tier: 'summary', holders: ['pin']});
    meta.set('schemas', clientSchemas());
    const t = setup({meta});
    t.pool.batch(() => t.pool.put('Issue', 1, 'repo:1', 500, {id: 1, repo_id: 1, title: 'stale', state: 'open', updated_at: NOW} as never));
    t.server.boots.set('repo:1', [{watermark: 20, units: ['issues'], lines: [issueChange(1, 20, 'fresh')]}]);
    const ws = await connected(t);
    ws.emit(welcome({server_sync_id: 20, granted: [{group: 'repo:1', units: ['issues']}]}));
    ws.emit({type: 'bootstrap_required', group: 'repo:1', reason: 'cursor_unknown'});
    await vi.waitFor(() => {
      expect(t.pool.model('Issue').get(1)?.get('title')).toBe('fresh');
    });
    expect(t.c.groups.get('repo:1')?.position).toBe(20);
    expect(t.persister.dropGroups).toHaveBeenCalledWith(['repo:1']);
  });

  test('the own profile outside its subscription raises no position', async () => {
    const meta = new MetaCache();
    meta.set('group:profiles:public', {group: 'profiles:public', position: 10, units: [], watermark: 10, tier: 'full', holders: ['pin']});
    meta.set('schemas', clientSchemas());
    const t = setup({meta});
    const ws = await connected(t);
    ws.emit(welcome({server_sync_id: 100, granted: [{group: 'profiles:public', units: []}]}));
    ws.emit({type: 'delta', to: 100, changes: [{v: 90, g: 'profiles:public', m: 'User', id: 1, op: 'U', d: {id: 1, login: 'me'}}]});
    expect(t.pool.model('User').get(1)).toBeDefined();
    expect(t.c.groups.get('profiles:public')?.position).toBe(10);
  });

  test('a bootstrap finishing between hello and welcome is subscribed after the welcome', async () => {
    const t = setup();
    let open!: () => void;
    t.server.boots.set('repo:1', [{watermark: 20, gate: new Promise<void>((r) => {
      open = r;
    })}]);
    t.c.hold('repo:1', 'tab:a');
    const ws = await connected(t);
    expect(ws.last('hello')?.groups).toEqual([]);
    open();
    await vi.waitFor(() => {
      expect(t.c.groups.get('repo:1')?.position).toBe(20);
    });
    expect(ws.last('subscribe')).toBeUndefined();
    ws.emit(welcome());
    expect(ws.last('subscribe')?.groups).toEqual([{group: 'repo:1', since: 20}]);
  });

  test('a model re-bootstrap with other units keeps the held units, so the full one replaces the closed tier', async () => {
    const meta = new MetaCache();
    meta.set('group:repo:1', {group: 'repo:1', position: 10, units: ['issues', 'pulls'], watermark: 10, tier: 'summary', closedBefore: 1_790_000_000, holders: ['pin']});
    meta.set('schemas', clientSchemas());
    const t = setup({meta});
    t.pool.batch(() => t.pool.put('Issue', 7, 'repo:1', 5, {id: 7, repo_id: 1, title: 'old closed PR', state: 'closed', is_pull: true, updated_at: '2020-01-01T00:00:00Z'} as never));
    t.server.boots.set('repo:1', [
      {watermark: 30, units: ['issues'], closed_before: 1_790_000_000},
      {watermark: 31, units: ['issues'], lines: [issueChange(1, 31, 'open')], closed_before: 1_790_000_000},
    ]);
    const ws = await connected(t);
    ws.emit(welcome({server_sync_id: 30, granted: [{group: 'repo:1', units: ['issues', 'pulls']}]}));
    ws.emit({type: 'bootstrap_required', group: 'repo:1', reason: 'trigger_repaired', model: 'Label'});
    await vi.waitFor(() => {
      expect(t.c.groups.get('repo:1')?.watermark).toBe(31);
    });
    expect(t.pool.model('Issue').get(7)).toBeUndefined();
    expect(t.c.groups.get('repo:1')?.units).toEqual(['issues']);
  });

  test('a late answer to a superseded subscribe does not count for the group held again', async () => {
    const meta = new MetaCache();
    meta.set('schemas', clientSchemas());
    const t = setup({meta});
    t.server.boots.set('repo:1', [{watermark: 20}, {watermark: 40}]);
    const ws = await connected(t);
    ws.emit(welcome());
    t.c.hold('repo:1', 'tab:a');
    await vi.waitFor(() => {
      expect(ws.last('subscribe')?.groups).toEqual([{group: 'repo:1', since: 20}]);
    });
    t.c.release('repo:1', 'tab:a');
    t.c.groups.update('repo:1', (x) => {
      x.holders = [];
    });
    t.c.hold('repo:2', 'tab:z'); // recompute: repo:1 released
    expect(ws.last('unsubscribe')?.groups).toEqual(['repo:1']);
    let open!: () => void;
    t.server.boots.set('repo:1', [{watermark: 40, gate: new Promise<void>((r) => {
      open = r;
    })}]);
    t.c.hold('repo:1', 'tab:a');
    // The answer to the first subscribe arrives now, then a frame: neither concerns the new hold.
    ws.emit({type: 'subscribed', granted: [{group: 'repo:1', units: []}], refused: []});
    ws.emit({type: 'caught_up', sync_id: 30});
    ws.emit({type: 'delta', to: 50, changes: []});
    expect(t.c.groups.get('repo:1')?.position).toBeUndefined();
    open();
    await vi.waitFor(() => {
      expect(t.c.groups.get('repo:1')?.position).toBe(40);
    });
    expect(ws.sent.filter((m) => m.type === 'subscribe').at(-1)?.groups).toEqual([{group: 'repo:1', since: 40}]);
  });

  test('a grant for a group released meanwhile is unsubscribed, its deltas ignored', async () => {
    const meta = new MetaCache();
    meta.set('group:repo:1', {group: 'repo:1', position: 10, units: [], watermark: 10, holders: ['pin']});
    meta.set('schemas', clientSchemas());
    const t = setup({meta});
    const ws = await connected(t);
    t.c.pin('repo:1', false);
    expect(t.c.isHeld('repo:1')).toBe(false);
    ws.emit(welcome({granted: [{group: 'repo:1', units: []}]}));
    expect(ws.last('unsubscribe')?.groups).toEqual(['repo:1']);
    ws.emit({type: 'delta', to: 12, changes: [issueChange(1, 11, 'x')]});
    expect(t.pool.model('Issue').size).toBe(0);
  });

  test('barriers: at most 16 pending; too_many_barriers rejects the last', async () => {
    const t = setup();
    const ws = await connected(t);
    ws.emit(welcome());
    const ps = Array.from({length: 16}, () => t.c.barrier().catch((e: unknown) => String(e)));
    await expect(t.c.barrier()).rejects.toThrow(/too many/);
    ws.emit({type: 'error', code: 'too_many_barriers', message: 'x'});
    await expect(ps[15]).resolves.toMatch(/too many/);
  });
});
