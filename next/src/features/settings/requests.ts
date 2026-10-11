// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The settings pages' API v1 requests (online only, PLAN §5.4: settings are
// never queued). Each names the repository as the pool spells it now.

import {online} from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import type {RepoPatch} from './forms.ts';
import {byLogin, type BranchProtection, type Collaborator, type DeployKey, type Hook, type Role, roleOf} from './rules.ts';
import {eachLimited} from './resource.ts';

export function repoApi(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** API v1's Repository, the fields the settings read back. */
export interface ApiRepo {
  id: number;
  name: string;
  full_name: string;
  owner?: {login?: string};
}

export function patchRepo(app: App, owner: string, repo: string, body: RepoPatch): Promise<ApiRepo | undefined> {
  return online<ApiRepo>(app, {method: 'PATCH', api: 'v1', path: repoApi(owner, repo), body});
}

export function transferRepo(app: App, owner: string, repo: string, newOwner: string): Promise<ApiRepo | undefined> {
  return online<ApiRepo>(app, {method: 'POST', api: 'v1', path: `${repoApi(owner, repo)}/transfer`, body: {new_owner: newOwner}});
}

export async function deleteRepo(app: App, owner: string, repo: string): Promise<void> {
  await online(app, {method: 'DELETE', api: 'v1', path: repoApi(owner, repo)});
}

interface ApiUser {
  id: number;
  login: string;
  full_name?: string;
  avatar_url?: string;
}

const PAGE = 50;

/** Every page of a list endpoint (`?limit=50&page=n` until a short page). */
async function allPages<T>(app: App, path: string, signal: AbortSignal): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 20; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const got = await online<T[]>(app, {api: 'v1', path: `${path}${sep}limit=${String(PAGE)}&page=${String(page)}`, signal}) ?? [];
    out.push(...got);
    if (got.length < PAGE) break;
  }
  return out;
}

/** The collaborators with their exact roles (one request for the list, one per person for the role). */
export async function fetchCollaborators(app: App, owner: string, repo: string, signal: AbortSignal): Promise<Collaborator[]> {
  const base = repoApi(owner, repo);
  const users = await allPages<ApiUser>(app, `${base}/collaborators`, signal);
  const roles = await eachLimited(users, 6, async (u) => {
    try {
      const p = await online<{permission?: string}>(app, {api: 'v1', path: `${base}/collaborators/${encodeURIComponent(u.login)}/permission`, signal});
      return roleOf(p?.permission ?? 'read');
    } catch (err) {
      if (signal.aborted) throw err;
      return undefined;
    }
  });
  return users.map((u, i): Collaborator => {
    const role = roles[i];
    return {id: u.id, login: u.login, name: (u.full_name ?? '') || u.login, avatar: u.avatar_url ?? '', role: role ?? 'write', ...(role ? {} : {approximate: true})};
  }).sort(byLogin);
}

export async function putCollaborator(app: App, owner: string, repo: string, login: string, role: Role): Promise<void> {
  await online(app, {method: 'PUT', api: 'v1', path: `${repoApi(owner, repo)}/collaborators/${encodeURIComponent(login)}`, body: {permission: role}});
}

export async function removeCollaborator(app: App, owner: string, repo: string, login: string): Promise<void> {
  await online(app, {method: 'DELETE', api: 'v1', path: `${repoApi(owner, repo)}/collaborators/${encodeURIComponent(login)}`});
}

export interface FoundUser {
  id: number;
  login: string;
  name: string;
  avatar: string;
}

/** People whose login or name has the query (API v1 `/users/search`). */
export async function searchUsers(app: App, query: string, signal: AbortSignal): Promise<FoundUser[]> {
  const params = new URLSearchParams({q: query.trim(), limit: '10'});
  const res = await online<{data?: ApiUser[]}>(app, {api: 'v1', path: `/users/search?${params.toString()}`, signal, timeout: 10_000});
  return (res?.data ?? []).filter((u) => typeof u.id === 'number' && typeof u.login === 'string')
    .map((u) => ({id: u.id, login: u.login, name: (u.full_name ?? '') || u.login, avatar: u.avatar_url ?? ''}));
}

export async function fetchRules(app: App, owner: string, repo: string, signal: AbortSignal): Promise<BranchProtection[]> {
  const rules = await online<BranchProtection[]>(app, {api: 'v1', path: `${repoApi(owner, repo)}/branch_protections`, signal}) ?? [];
  return rules.map((r) => ({...r, rule_name: r.rule_name || (r.branch_name ?? '')}));
}

/** A rule's address: its name is a path segment (a pattern may hold "/" and "*"). */
export function ruleApi(owner: string, repo: string, name: string): string {
  return `${repoApi(owner, repo)}/branch_protections/${encodeURIComponent(name)}`;
}

export function fetchHooks(app: App, owner: string, repo: string, signal: AbortSignal): Promise<Hook[]> {
  return allPages<Hook>(app, `${repoApi(owner, repo)}/hooks`, signal);
}

/** A hook as it is now (its authorization header included: an edit must send it back). */
export async function fetchHook(app: App, owner: string, repo: string, id: number): Promise<Hook | undefined> {
  return online<Hook>(app, {api: 'v1', path: `${repoApi(owner, repo)}/hooks/${String(id)}`});
}

/** What is written to IndexedDB of the hooks: their authorization headers (secrets) stay in memory only. */
export function storedHooks(hooks: Hook[]): Hook[] {
  return hooks.map(({authorization_header: _, ...h}) => h);
}

export function fetchKeys(app: App, owner: string, repo: string, signal: AbortSignal): Promise<DeployKey[]> {
  return allPages<DeployKey>(app, `${repoApi(owner, repo)}/keys`, signal);
}
