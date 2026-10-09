// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The data layer against a real Forgejo with livesync enabled (F2
// acceptance): bootstrap → live delta in the pool, over WebSocket and over
// the SSE fallback; persisted state hydrates a second session offline and
// resumes from its positions. Run with
//
//   next/tools/dev-db.sh start pg
//   NEXT_FORGEJO_EXTRA_INI=$'[livesync]\nENABLED = true' next/tools/dev-forgejo.sh restart pg
//   NEXT_FORGEJO_URL=http://127.0.0.1:3000 npm run test:integration
//
// (dev-forgejo.sh creates the site admin dev / devdevdev1 the test uses.)

import 'fake-indexeddb/auto';
import {IDBFactory, IDBKeyRange} from 'fake-indexeddb';
import {reaction} from 'mobx';
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {type Data, openData} from '../src/sync/data.ts';

const BASE = process.env.NEXT_FORGEJO_URL ?? '';
const USER = process.env.NEXT_FORGEJO_USER ?? 'dev';
const PASS = process.env.NEXT_FORGEJO_PASSWORD ?? 'devdevdev1';

let token = '';
let userId = 0;
let repo = '';
let repoId = 0;

async function api<T>(method: string, path: string, body?: unknown, basic = false): Promise<T> {
  const auth = basic ? `Basic ${btoa(`${USER}:${PASS}`)}` : `token ${token}`;
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method, headers: {'Content-Type': 'application/json', Authorization: auth}, ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined as T : await res.json() as T;
}

/** A minimal EventSource over fetch (Node has none without a flag; jsdom has none). */
class FetchEventSource {
  onmessage: ((ev: {data: string}) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly ctrl = new AbortController();

  constructor(url: string) {
    void this.run(url);
  }

  close(): void {
    this.ctrl.abort();
  }

  private async run(url: string): Promise<void> {
    try {
      const res = await fetch(url, {signal: this.ctrl.signal, headers: {Accept: 'text/event-stream'}});
      if (!res.body) throw new Error('no body');
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (data) this.onmessage?.({data});
        }
      }
      this.onerror?.();
    } catch {
      if (!this.ctrl.signal.aborted) this.onerror?.();
    }
  }
}

function open(factory: IDBFactory, transport: 'ws' | 'sse', route?: string[]): Promise<Data> {
  return openData({
    userId, auth: {token: () => Promise.resolve(token), refresh: () => Promise.resolve(token)},
    endpoint: `${BASE}/-/sync`, transport, persistStorage: false, ...(route ? {route} : {}),
    env: {indexedDB: factory, IDBKeyRange, locks: null, BroadcastChannel: null, transport: {base: BASE, EventSource: FetchEventSource as unknown as typeof EventSource}},
  });
}

async function issueIn(d: Data, title: string): Promise<number> {
  let id = 0;
  await vi.waitFor(() => {
    for (const e of d.pool.model('Issue').by('repo_id', repoId)) if (e.get('title') === title) id = e.id;
    expect(id).toBeGreaterThan(0);
  }, {timeout: 20_000, interval: 20});
  return id;
}

describe.skipIf(!BASE)('livesync end to end', () => {
  beforeAll(async () => {
    const me = await api<{id: number}>('GET', '/user', undefined, true);
    userId = me.id;
    const t = await api<{sha1: string}>('POST', `/users/${USER}/tokens`, {name: `f2-${Date.now()}`, scopes: ['all']}, true);
    token = t.sha1;
    repo = `f2-${Date.now()}`;
    const r = await api<{id: number}>('POST', '/user/repos', {name: repo});
    repoId = r.id;
    await api('POST', `/repos/${USER}/${repo}/issues`, {title: 'first issue', body: 'hello @dev'});
  });

  const factory = new IDBFactory();
  const opened: Data[] = [];
  afterAll(async () => {
    for (const d of opened) await d.close();
    if (repo) await api('DELETE', `/repos/${USER}/${repo}`).catch(() => undefined);
  });

  test('WebSocket: bootstrap → live deltas → lazy issue load → barrier', async () => {
    const d = await open(factory, 'ws');
    opened.push(d);
    await d.hydrated;
    await vi.waitFor(() => {
      expect(d.status.connection).toBe('live');
    }, {timeout: 30_000});
    const first = await issueIn(d, 'first issue');
    expect(d.pool.model('Repository').get(repoId)?.get('name')).toBe(repo);
    expect(d.pool.model('User').get(userId)?.get('login')).toBe(USER);

    // A write through API v1 reaches the pool as a delta.
    const t0 = performance.now();
    const created = await api<{id: number; number: number}>('POST', `/repos/${USER}/${repo}/issues`, {title: 'second issue'});
    expect(await issueIn(d, 'second issue')).toBe(created.id);
    const latency = performance.now() - t0;
    console.log(`API write → pool: ${latency.toFixed(0)} ms`);

    // Field-level reactivity on a live update.
    const e = d.pool.model('Issue').get(created.id);
    const titles: string[] = [];
    const stop = reaction(() => e?.get('title'), (t) => titles.push(t ?? ''));
    await api('PATCH', `/repos/${USER}/${repo}/issues/${created.number}`, {title: 'renamed'});
    await vi.waitFor(() => {
      expect(titles).toEqual(['renamed']);
    }, {timeout: 20_000});
    stop();

    // The lazy tier of an issue.
    d.hold(`issue:${first}`);
    await vi.waitFor(() => {
      expect(d.pool.model('IssueBody').get(first)?.get('body')).toBe('hello @dev');
    }, {timeout: 20_000});
    expect(d.pool.model('IssueBody').get(first)?.get('body_html')).toContain('class="mention"');
    await api('POST', `/repos/${USER}/${repo}/issues/1/comments`, {body: 'a comment'});
    await vi.waitFor(() => {
      expect([...d.pool.model('Comment').by('issue_id', first)].map((c) => c.get('body'))).toContain('a comment');
    }, {timeout: 20_000});

    const at = await d.barrier();
    expect(at).toBeGreaterThan(0);
    await d.close();
    opened.splice(opened.indexOf(d), 1);
  });

  test('a second session hydrates from IndexedDB first, then resumes', async () => {
    const d = await open(factory, 'ws');
    opened.push(d);
    await d.firstRoute;
    await d.hydrated;
    // Everything is there before the network said anything.
    expect([...d.pool.model('Issue').by('repo_id', repoId)].map((e) => e.get('title')).sort()).toEqual(['first issue', 'renamed']);
    await vi.waitFor(() => {
      expect(d.status.connection).toBe('live');
    }, {timeout: 30_000});
    await api('POST', `/repos/${USER}/${repo}/issues`, {title: 'after resume'});
    await issueIn(d, 'after resume');
    await d.close();
    opened.splice(opened.indexOf(d), 1);
  });

  test('SSE + POST fallback: same protocol', async () => {
    const d = await open(new IDBFactory(), 'sse');
    opened.push(d);
    await vi.waitFor(() => {
      expect(d.status.connection).toBe('live');
    }, {timeout: 30_000});
    expect(d.status.transport).toBe('sse');
    await issueIn(d, 'after resume');
    await api('POST', `/repos/${USER}/${repo}/issues`, {title: 'over sse'});
    await issueIn(d, 'over sse');
  });
});
