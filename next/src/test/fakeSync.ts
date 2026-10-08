// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A scripted sync server for tests: a fake WebSocket / EventSource and a fake
// fetch that serves the workspace and NDJSON bootstraps.

import type {Change, ServerMessage, Workspace} from '../protocol/types.gen.ts';

export type Sent = Record<string, unknown> & {type: string};

export class FakeWS {
  static readonly OPEN = 1;
  static all: FakeWS[] = [];
  readonly url: string;
  readyState = 0;
  sent: Sent[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: {data: string}) => void) | null = null;
  onclose: ((ev: {code: number; reason: string}) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWS.all.push(this);
  }

  /** The socket opened last. */
  static latest(): FakeWS {
    const ws = FakeWS.all.at(-1);
    if (!ws) throw new Error('no WebSocket was opened');
    return ws;
  }

  send(s: string): void {
    this.sent.push(JSON.parse(s) as Sent);
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({code, reason: ''});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(msg: ServerMessage): void {
    this.onmessage?.({data: JSON.stringify(msg)});
  }

  private answered = 0;

  /** Answers every subscribe not answered yet, one `subscribed` each (as the server does), granting all. */
  grantSubscribes(units: Record<string, string[]> = {}): void {
    const subs = this.sent.filter((m) => m.type === 'subscribe');
    for (const m of subs.slice(this.answered)) {
      const groups = (m.groups as {group: string}[]).map((g) => ({group: g.group, units: units[g.group] ?? []}));
      this.emit({type: 'subscribed', granted: groups, refused: []});
    }
    this.answered = subs.length;
  }

  last(type: string): Sent | undefined {
    return this.sent.filter((m) => m.type === type).at(-1);
  }
}

export class FakeES {
  static all: FakeES[] = [];
  readonly url: string;
  onmessage: ((ev: {data: string}) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeES.all.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emit(msg: ServerMessage): void {
    this.onmessage?.({data: JSON.stringify(msg)});
  }
}

export const NOW = '2026-10-01T00:00:00Z';

export function issueChange(id: number, v: number, title: string, g = 'repo:1', extra: Record<string, unknown> = {}): Change {
  return {v, g, m: 'Issue', id, op: 'U', d: {id, repo_id: 1, title, state: 'open', updated_at: NOW, ...extra}};
}

export interface Boot {
  watermark: number;
  units?: string[];
  lines?: Change[];
  refs?: string[];
  closed_before?: number;
  status?: number;
  retryAfter?: string;
  incomplete?: boolean;
  /** The response is sent once this resolves. */
  gate?: Promise<void>;
}

export class Server {
  boots = new Map<string, Boot[]>();
  requests: string[] = [];
  workspace: Workspace = {viewer_id: 1, groups: [], truncated: false, max_repos: 200};

  fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    this.requests.push(url);
    const auth = new Headers(init?.headers).get('Authorization');
    if (auth !== 'Bearer tok') return Promise.resolve(new Response('{"message":"bad token"}', {status: 401}));
    if (url.endsWith('/workspace')) return Promise.resolve(Response.json(this.workspace));
    const u = new URL(url, 'http://x');
    const group = u.searchParams.get('group') ?? '';
    const list = this.boots.get(group) ?? [];
    const b = list.length > 1 ? list.shift() : list[0];
    if (b?.gate) {
      const gate = b.gate;
      delete b.gate;
      if (list[0] !== b) list.unshift(b);
      this.requests.pop();
      return gate.then(() => this.fetch(input, init));
    }
    if (!b) return Promise.resolve(new Response('{"message":"Not Found"}', {status: 404}));
    if (b.status) {
      const headers: Record<string, string> = b.retryAfter ? {'Retry-After': b.retryAfter} : {};
      return Promise.resolve(new Response('{"message":"x"}', {status: b.status, headers}));
    }
    const header: Record<string, unknown> = {type: 'header', group, watermark: b.watermark, units: b.units ?? [], tier: group.startsWith('repo:') ? 'summary' : 'full', schemas: {}};
    const models = u.searchParams.get('model');
    if (models) header.models = models.split(',');
    if (b.closed_before !== undefined) header.closed_before = b.closed_before;
    const lines: unknown[] = [header, ...(b.lines ?? [])];
    if (!b.incomplete) lines.push({type: 'end', count: (b.lines ?? []).filter((l) => l.g === group).length, refs: b.refs ?? []});
    return Promise.resolve(new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {status: 200}));
  };
}
