// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The server's ordinary HTTP API (API v1, the classic web UI's forms) as the
// scenarios use it: accounts, repositories and writes. Every scenario
// creates its own users and repositories (unique names), so files and runs
// do not depend on each other or on what the database already holds.

import {HeaderIdempotencyKey} from '../src/protocol/types.gen.ts';
import {env} from './env.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path}: ${status} ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

let seq = 0;
/** A name no other scenario or run uses (lower case, ≤ 30 characters). */
export function unique(prefix: string): string {
  seq++;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export interface Account {
  id: number;
  login: string;
  password: string;
  /** A personal access token with every scope (livesync wants read access to everything). */
  token: string;
}

export interface RequestOptions {
  token?: string;
  basic?: {user: string; password: string};
  body?: unknown;
  headers?: Record<string, string>;
  /** Sent as Idempotency-Key. */
  key?: string;
}

/** One request to the server (path absolute, e.g. /api/v1/version); never throws on a status. */
export function request(method: string, path: string, o: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {...o.headers};
  if (o.token) headers.Authorization = `token ${o.token}`;
  if (o.basic) headers.Authorization = `Basic ${btoa(`${o.basic.user}:${o.basic.password}`)}`;
  if (o.key) headers[HeaderIdempotencyKey] = o.key;
  let body: string | undefined;
  if (o.body !== undefined) {
    headers['Content-Type'] ??= 'application/json';
    body = JSON.stringify(o.body);
  }
  return fetch(`${env.url}${path}`, {method, headers, redirect: 'manual', ...(body === undefined ? {} : {body})});
}

/** An API v1 call that must succeed; answers the decoded JSON (undefined for 204). */
export async function api<T>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
  const res = await request(method, `/api/v1${path}`, o);
  const text = await res.text();
  if (!res.ok) throw new HttpError(method, `/api/v1${path}`, res.status, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

let adminPromise: Promise<Account> | undefined;

/** The site administrator the run was given, with a fresh token. */
export function admin(): Promise<Account> {
  adminPromise ??= (async () => {
    const basic = {user: env.adminUser, password: env.adminPassword};
    const me = await api<{id: number; login: string}>('GET', '/user', {basic});
    const t = await api<{sha1: string}>('POST', `/users/${me.login}/tokens`, {basic, body: {name: unique('conformance'), scopes: ['all']}});
    return {id: me.id, login: me.login, password: env.adminPassword, token: t.sha1};
  })();
  return adminPromise;
}

/** A new user (created by the administrator) with a token. */
export async function createUser(prefix: string): Promise<Account> {
  const a = await admin();
  const login = unique(prefix);
  const password = `pw-${login}-1A!`;
  const u = await api<{id: number; login: string}>('POST', '/admin/users', {
    token: a.token,
    body: {username: login, email: `${login}@conformance.invalid`, password, must_change_password: false},
  });
  const t = await api<{sha1: string}>('POST', `/users/${login}/tokens`, {
    basic: {user: login, password}, body: {name: 'conformance', scopes: ['all']},
  });
  return {id: u.id, login: u.login, password, token: t.sha1};
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  /** owner/name, for API v1 paths. */
  full: string;
  group: string;
}

/** A new repository of `owner` (private, or with a README commit on `main` when asked). */
export async function createRepo(owner: Account, o: {private?: boolean; init?: boolean} = {}): Promise<Repo> {
  const r = await api<{id: number; name: string; owner: {login: string}}>('POST', '/user/repos', {
    token: owner.token,
    body: {name: unique('repo'), private: o.private ?? false, auto_init: o.init ?? false, default_branch: 'main', readme: 'Default'},
  });
  return {id: r.id, name: r.name, owner: r.owner.login, full: `${r.owner.login}/${r.name}`, group: `repo:${r.id}`};
}

export interface IssueRef {
  id: number;
  number: number;
}

export function createIssue(who: Account, repo: Repo, title: string, body = ''): Promise<IssueRef> {
  return api<IssueRef>('POST', `/repos/${repo.full}/issues`, {token: who.token, body: {title, body}});
}

/** The sync id echo (X-Livesync-Sync-Id) of a response, or undefined. */
export function syncId(res: Response): number | undefined {
  const v = res.headers.get('X-Livesync-Sync-Id');
  return v === null ? undefined : Number(v);
}

/**
 * A signed-in session of the classic web UI (cookies). Forgejo protects its
 * forms with Go's cross-origin protection (Sec-Fetch-Site / Origin), not
 * CSRF tokens, so a non-browser client posts forms like the UI does. Used
 * for what API v1 cannot do (projects).
 */
export class WebSession {
  private readonly cookies = new Map<string, string>();

  static async signIn(who: Account): Promise<WebSession> {
    const s = new WebSession();
    const res = await s.form('/user/login', {user_name: who.login, password: who.password});
    if (res.status !== 303 && res.status !== 302) throw new Error(`sign-in of ${who.login}: ${res.status}`);
    return s;
  }

  async form(path: string, fields: Record<string, string>): Promise<Response> {
    const res = await fetch(`${env.url}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {'Content-Type': 'application/x-www-form-urlencoded', Cookie: this.cookieHeader()},
      body: new URLSearchParams(fields).toString(),
    });
    this.remember(res);
    return res;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private remember(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair?.indexOf('=') ?? -1;
      if (pair && i > 0) this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
}

/** Polls `fn` until it returns a value other than undefined/false (or throws after `timeout` ms). */
export async function eventually<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
    await sleep(50);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
