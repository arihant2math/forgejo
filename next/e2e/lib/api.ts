// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// API v1 with basic auth (fixtures and server-side checks), and the seeds.

import {execFileSync} from 'node:child_process';
import {expect} from '@playwright/test';
import {ALICE, BASE, basic, PASSWORD, USER} from './env.ts';

export async function api(method: string, path: string, body?: object, as = basic(USER, PASSWORD)): Promise<Response> {
  return fetch(`${BASE}/api/v1${path}`, {
    method, headers: {'Authorization': as, 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {}),
  });
}

/** Fails with the server's answer unless `res` is 2xx. */
export async function ok(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what}: ${String(res.status)} ${await res.text()}`);
  return res;
}

/** The JSON of a 2xx answer, typed by the caller. */
export async function apiJson<T = unknown>(method: string, path: string, body?: object, as?: string): Promise<T> {
  return await (await ok(await api(method, path, body, as), `${method} ${path}`)).json() as T;
}

/**
 * Seeds `repo` of dev with `n` issues, labels, milestones and alice (tools/seed-issues.ts; idempotent).
 * `plain`: titles and bodies only (search fixtures; much faster to create).
 */
export function seed(repo: string, n: number, {concurrency = 8, plain = false} = {}): void {
  execFileSync('node', ['tools/seed-issues.ts', '--url', BASE, '--repo', repo, '--issues', String(n), '--concurrency', String(concurrency), ...(plain ? ['--plain'] : [])], {stdio: 'inherit'});
}

/** Makes sure a user exists (alice's password for every e2e user). */
export async function ensureUser(login: string): Promise<void> {
  if ((await api('GET', `/users/${login}`)).status === 200) return;
  await ok(await api('POST', '/admin/users', {username: login, password: ALICE.password, email: `${login}@example.com`, must_change_password: false}), `create ${login}`);
}

export interface ApiIssue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: {id: number; name: string}[];
}

export async function newIssue(owner: string, repo: string, title: string, body = '', as?: string): Promise<ApiIssue> {
  const res = await api('POST', `/repos/${owner}/${repo}/issues`, {title, body}, as);
  expect(res.status).toBe(201);
  return await res.json() as ApiIssue;
}

export async function labelId(owner: string, repo: string, name: string): Promise<number> {
  const labels = await apiJson<{id: number; name: string}[]>('GET', `/repos/${owner}/${repo}/labels?limit=100`);
  const l = labels.find((x) => x.name === name);
  if (!l) throw new Error(`no label ${name}`);
  return l.id;
}

export const b64 = (s: string) => Buffer.from(s).toString('base64');
