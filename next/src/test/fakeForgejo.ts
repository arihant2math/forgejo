// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A small Forgejo for the intent queue's tests: one repository (dev/big),
// its issues with state, title, milestone, labels, assignees, a body and
// comments; the API v1 and gap-endpoint (B9) calls the queue makes; B7's
// idempotency (a completed key replays its answer, the same key with
// another request is 422, a key whose attempt is still running is 409 +
// Retry-After); a sync log of entity states (the deltas the tabs' pools
// receive, with X-Livesync-Sync-Id); other users' changes; and faults —
// answers lost on the way back, 503s, a slow server.

import type {ModelName, ModelTypes} from '../data/models.ts';
import type {Pool} from '../data/pool.ts';
import {comment as commentDto, issue as issueDto, repo, T, user} from './fakeSession.ts';

export const DEV = 1;
export const ALICE = 2;
export const REPO = 10;

interface IssueState {
  id: number;
  number: number;
  title: string;
  state: string;
  milestone: number;
  labels: Set<number>;
  assignees: Set<number>;
  body: string;
  version: number;
  deleted: boolean;
}

interface CommentState {
  id: number;
  issueId: number;
  body: string;
  version: number;
  updated: string;
  poster: number;
  deleted: boolean;
}

export interface LogEntry {
  v: number;
  m: ModelName;
  id: number;
  g: string;
  op: 'U' | 'D';
  d?: unknown;
}

export class FakeForgejo {
  v = 100;
  readonly log: LogEntry[] = [];
  readonly issues = new Map<number, IssueState>();
  readonly comments = new Map<number, CommentState>();
  private nextIssue = 1000;
  private nextComment = 5000;
  private clock = 0;
  /** Idempotency records: key → request hash and stored answer. */
  private readonly keys = new Map<string, {hash: string; status: number; body: string; v: number} | 'running'>();
  /** How many times each key's request ran (must never exceed 1). */
  readonly runs = new Map<string, number>();
  /** Requests answered 422 (a key reused with another request: a client bug). */
  readonly mismatches: string[] = [];
  /** Faults for the next requests. */
  lose = 0;
  fail = 0;
  online = true;
  /** While set, requests wait for it (a request in flight). */
  gate: Promise<void> | undefined;

  constructor(issueCount = 3, labelCount = 4) {
    for (let n = 1; n <= issueCount; n++) {
      this.issues.set(n, {id: n, number: n, title: `Issue ${String(n)}`, state: 'open', milestone: 0, labels: new Set(), assignees: new Set(), body: 'one\ntwo\nthree', version: 0, deleted: false});
    }
    this.emit('User', DEV, 'profiles:public', user(DEV, 'dev'));
    this.emit('User', ALICE, 'profiles:public', user(ALICE, 'alice'));
    this.emit('Repository', REPO, `repo:${String(REPO)}`, repo(REPO, user(DEV, 'dev'), 'big'));
    for (let l = 1; l <= labelCount; l++) {
      this.emit('Label', l, `repo:${String(REPO)}`, {id: l, repo_id: REPO, org_id: 0, name: `l${String(l)}`, exclusive: false, description: '', color: '#888888', num_issues: 0, num_closed_issues: 0, created_at: T});
    }
    for (const s of this.issues.values()) this.emitIssue(s, true);
  }

  private emit<M extends ModelName>(m: M, id: number, g: string, d: ModelTypes[M] | undefined): void {
    this.log.push({v: ++this.v, m, id, g, op: d === undefined ? 'D' : 'U', ...(d === undefined ? {} : {d})});
  }

  private now(): string {
    return new Date(Date.UTC(2026, 9, 1) + ++this.clock * 1000).toISOString();
  }

  private emitIssue(s: IssueState, full = false, prev?: {labels: Set<number>; assignees: Set<number>}): void {
    const g = `repo:${String(REPO)}`;
    if (s.deleted) {
      this.emit('Issue', s.id, g, undefined);
      return;
    }
    this.emit('Issue', s.id, g, issueDto(s.id, REPO, s.number, s.title, {state: s.state, milestone_id: s.milestone}));
    for (const l of s.labels) if (full || !prev?.labels.has(l)) this.emit('IssueLabel', s.id * 1000 + l, g, {id: s.id * 1000 + l, issue_id: s.id, label_id: l});
    for (const l of prev?.labels ?? []) if (!s.labels.has(l)) this.emit('IssueLabel', s.id * 1000 + l, g, undefined);
    for (const u of s.assignees) if (full || !prev?.assignees.has(u)) this.emit('IssueAssignee', s.id * 1000 + 900 + u, g, {id: s.id * 1000 + 900 + u, issue_id: s.id, assignee_id: u});
    for (const u of prev?.assignees ?? []) if (!s.assignees.has(u)) this.emit('IssueAssignee', s.id * 1000 + 900 + u, g, undefined);
    if (full) this.emitBody(s);
  }

  private emitBody(s: IssueState): void {
    this.emit('IssueBody', s.id, `issue:${String(s.id)}`, {id: s.id, repo_id: REPO, body: s.body, body_html: `<p>${s.body}</p>`, content_version: s.version});
  }

  private emitComment(c: CommentState): void {
    const g = `issue:${String(c.issueId)}`;
    this.emit('Comment', c.id, g, c.deleted ? undefined : commentDto(c.id, c.issueId, c.body, {poster_id: c.poster, content_version: c.version, updated_at: c.updated, body_html: `<p>${c.body}</p>`}));
  }

  /** Applies the log after `from` to a pool; returns the new position. */
  deliver(pool: Pool, from: number, upTo = Number.POSITIVE_INFINITY): number {
    let pos = from;
    pool.batch(() => {
      for (const e of this.log) {
        if (e.v <= from || e.v > upTo) continue;
        if (e.op === 'U') pool.put(e.m, e.id, e.g, e.v, e.d as never);
        else pool.del(e.m, e.id, e.g, e.v);
        pos = e.v;
      }
    });
    return Math.max(pos, Math.min(this.v, upTo));
  }

  // ---- other users' changes ---------------------------------------------

  remote(op: RemoteOp): void {
    const s = this.issues.get(op.issue);
    if (!s || s.deleted) return;
    const prev = {labels: new Set(s.labels), assignees: new Set(s.assignees)};
    switch (op.t) {
      case 'state':
        s.state = s.state === 'open' ? 'closed' : 'open';
        break;
      case 'title':
        s.title = op.title;
        break;
      case 'label':
        if (op.add) s.labels.add(op.label);
        else s.labels.delete(op.label);
        break;
      case 'body': {
        const lines = s.body.split('\n');
        lines.splice(op.at % (lines.length + 1), 0, op.token);
        s.body = lines.join('\n');
        s.version++;
        this.emitBody(s);
        return;
      }
      case 'comment': {
        const c = [...this.comments.values()].find((x) => x.issueId === s.id && !x.deleted);
        if (!c) return;
        c.body = `${c.body} ${op.token}`;
        c.version++;
        c.updated = this.now();
        this.emitComment(c);
        return;
      }
      case 'delete':
        s.deleted = true;
        break;
    }
    this.emitIssue(s, false, prev);
  }

  // ---- the API -------------------------------------------------------------

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    await Promise.resolve();
    if (!this.online) throw new TypeError('Failed to fetch (offline)');
    if (this.gate) await this.gate;
    const headers = new Headers(init.headers);
    const key = headers.get('Idempotency-Key') ?? '';
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? init.body : '';
    const hash = `${method} ${url} ${body}`;
    if (this.fail > 0) {
      this.fail--;
      return new Response('{"message":"unavailable"}', {status: 503, headers: {'Retry-After': '0'}});
    }
    const lose = this.lose > 0;
    if (lose) this.lose--;
    const stored = this.keys.get(key);
    let res: Response;
    if (stored === 'running') {
      res = new Response('{"message":"in flight"}', {status: 409, headers: {'Retry-After': '1'}});
    } else if (stored) {
      if (stored.hash !== hash) {
        this.mismatches.push(`${key}: ${stored.hash} ≠ ${hash}`);
        res = new Response('{"message":"key reused"}', {status: 422});
      } else {
        res = new Response(stored.status === 204 ? null : stored.body, {status: stored.status, headers: {'X-Livesync-Sync-Id': String(stored.v), 'X-Livesync-Idempotent-Replay': 'true'}});
      }
    } else {
      this.keys.set(key, 'running');
      this.runs.set(key, (this.runs.get(key) ?? 0) + 1);
      const [status, out] = this.run(method, url, body ? JSON.parse(body) as Record<string, unknown> : {});
      const text = out === undefined ? '' : JSON.stringify(out);
      if (status >= 500) this.keys.delete(key);
      else this.keys.set(key, {hash, status, body: text, v: this.v});
      res = new Response(status === 204 ? null : text, {status, headers: {'X-Livesync-Sync-Id': String(this.v)}});
    }
    if (lose) throw new TypeError('Failed to fetch (answer lost)');
    return res;
  };

  private run(method: string, url: string, b: Record<string, unknown>): [number, unknown] {
    const notFound: [number, unknown] = [404, {message: 'not found'}];
    let m = /^\/-\/sync\/api\/issues\/(\d+)\/body$/.exec(url);
    if (m && method === 'PATCH') {
      const s = this.issues.get(Number(m[1]));
      if (!s || s.deleted) return notFound;
      if (b.expected_version !== s.version) return [409, {message: 'changed', body: s.body, content_version: s.version}];
      s.body = String(b.body);
      s.version++;
      this.emitBody(s);
      return [200, {content_version: s.version}];
    }
    m = /^\/-\/sync\/api\/comments\/(\d+)\/body$/.exec(url);
    if (m && method === 'PATCH') {
      const c = this.comments.get(Number(m[1]));
      if (!c || c.deleted) return notFound;
      if (b.expected_version !== c.version) return [409, {message: 'changed', body: c.body, content_version: c.version}];
      c.body = String(b.body);
      c.version++;
      c.updated = this.now();
      this.emitComment(c);
      return [200, {content_version: c.version}];
    }
    m = /^\/api\/v1\/repos\/dev\/big\/issues\/comments\/(\d+)$/.exec(url);
    if (m && method === 'DELETE') {
      const c = this.comments.get(Number(m[1]));
      if (!c || c.deleted) return notFound;
      c.deleted = true;
      this.emitComment(c);
      return [204, undefined];
    }
    if (url === '/api/v1/repos/dev/big/issues' && method === 'POST') {
      const id = ++this.nextIssue;
      const s: IssueState = {id, number: id, title: String(b.title), state: 'open', milestone: 0, labels: new Set(b.labels as number[]), assignees: new Set(), body: typeof b.body === 'string' ? b.body : '', version: 0, deleted: false};
      this.issues.set(id, s);
      this.emitIssue(s, true);
      return [201, {id, number: id}];
    }
    m = /^\/api\/v1\/repos\/dev\/big\/issues\/(\d+)(\/.*)?$/.exec(url);
    if (!m) return notFound;
    const number = Number(m[1]);
    const s = [...this.issues.values()].find((x) => x.number === number);
    if (!s || s.deleted) return notFound;
    const rest = m[2] ?? '';
    const prev = {labels: new Set(s.labels), assignees: new Set(s.assignees)};
    if (rest === '' && method === 'PATCH') {
      if (typeof b.state === 'string') s.state = b.state;
      if (typeof b.title === 'string' && b.title) s.title = b.title;
      if (typeof b.milestone === 'number') s.milestone = b.milestone;
      if (Array.isArray(b.assignees)) s.assignees = new Set((b.assignees as string[]).map((l) => (l === 'dev' ? DEV : ALICE)));
      this.emitIssue(s, false, prev);
      return [201, {id: s.id, number: s.number}];
    }
    if (rest === '/labels' && method === 'POST') {
      for (const l of b.labels as number[]) s.labels.add(l);
      this.emitIssue(s, false, prev);
      return [200, []];
    }
    const lm = /^\/labels\/(\d+)$/.exec(rest);
    if (lm && method === 'DELETE') {
      s.labels.delete(Number(lm[1]));
      this.emitIssue(s, false, prev);
      return [204, undefined];
    }
    if (rest === '/comments' && method === 'POST') {
      const c: CommentState = {id: ++this.nextComment, issueId: s.id, body: String(b.body), version: 0, updated: this.now(), poster: DEV, deleted: false};
      this.comments.set(c.id, c);
      this.emitComment(c);
      return [201, {id: c.id}];
    }
    return notFound;
  }
}

export type RemoteOp =
  | {t: 'state'; issue: number}
  | {t: 'title'; issue: number; title: string}
  | {t: 'label'; issue: number; label: number; add: boolean}
  | {t: 'body'; issue: number; at: number; token: string}
  | {t: 'comment'; issue: number; token: string}
  | {t: 'delete'; issue: number};
