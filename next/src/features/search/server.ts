// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The server's search (PLAN §5.1: Forgejo's indexers cover what is not on
// this device — closed issues beyond the summary tier, other repositories,
// body text, repositories and people outside the workspace). Online only;
// the palette asks it when typing pauses and shows what the local search did
// not find. An issue is kept only when the query's words are in its title or
// its description (the indexer also matches comments and fuzzy terms, which
// read as unrelated results in a list of titles).

import {online} from '../../app/api.ts';
import type {App} from '../../app/store.ts';

export interface ServerHit {
  id: number;
  number: number;
  title: string;
  state: string;
  pull: boolean;
  owner: string;
  repo: string;
  fullName: string;
}

interface ApiIssue {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  pull_request?: unknown;
  repository?: {owner?: unknown; name?: unknown; full_name?: unknown};
}

/** Parses API v1's issue list defensively (only well-formed entries come through). */
export function parseServerHits(list: unknown): ServerHit[] {
  if (!Array.isArray(list)) return [];
  const out: ServerHit[] = [];
  for (const raw of list as ApiIssue[]) {
    const r = raw.repository;
    if (typeof raw.id !== 'number' || typeof raw.number !== 'number' || typeof raw.title !== 'string' || !r ||
      typeof r.owner !== 'string' || typeof r.name !== 'string' || typeof r.full_name !== 'string') continue;
    out.push({
      id: raw.id, number: raw.number, title: raw.title, state: raw.state === 'closed' ? 'closed' : 'open',
      pull: raw.pull_request !== null && raw.pull_request !== undefined, owner: r.owner, repo: r.name, fullName: r.full_name,
    });
  }
  return out;
}

/** The issues of an API v1 list whose title or description has every word of the query (lower case). */
export function relevantHits(list: unknown, query: string): ServerHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const raw = Array.isArray(list) ? list as ApiIssue[] : [];
  const text = new Map(raw.map((r) => [r.id, `${typeof r.title === 'string' ? r.title : ''}\n${typeof r.body === 'string' ? r.body : ''}`.toLowerCase()]));
  return parseServerHits(list).filter((h) => words.every((w) => text.get(h.id)?.includes(w)));
}

/** Searches every issue and pull request the viewer can read (title and body), open and closed. */
export async function searchServer(app: App, query: string, signal: AbortSignal, limit = 10): Promise<ServerHit[]> {
  const params = new URLSearchParams({q: query, state: 'all', limit: String(limit)});
  const t0 = performance.now();
  const list = await online(app, {api: 'v1', path: `/repos/issues/search?${params.toString()}`, signal, timeout: 10_000});
  try {
    performance.measure('search:server', {start: t0, end: performance.now()});
  } catch {
    // No User Timing.
  }
  return relevantHits(list, query);
}

export interface ServerRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
}

export interface ServerUser {
  id: number;
  login: string;
  fullName: string;
}

/**
 * The repositories the viewer can see whose name has the query (public ones outside the workspace too);
 * "owner/name" names one.
 */
export async function searchServerRepos(app: App, query: string, signal: AbortSignal, limit = 5): Promise<ServerRepo[]> {
  const q = query.trim().toLowerCase();
  const slash = /^([\w.-]+)\/([\w.-]*)$/.exec(q);
  const params = new URLSearchParams({q: slash ? slash[2] ?? '' : q, limit: String(slash ? 20 : limit)});
  const res = await online<{data?: unknown}>(app, {api: 'v1', path: `/repos/search?${params.toString()}`, signal, timeout: 10_000});
  const out: ServerRepo[] = [];
  for (const r of Array.isArray(res?.data) ? res.data as {id?: unknown; name?: unknown; full_name?: unknown; description?: unknown; owner?: {login?: unknown}}[] : []) {
    if (typeof r.id !== 'number' || typeof r.name !== 'string' || typeof r.full_name !== 'string' || typeof r.owner?.login !== 'string') continue;
    if (slash && !r.full_name.toLowerCase().startsWith(q)) continue;
    out.push({id: r.id, owner: r.owner.login, name: r.name, fullName: r.full_name, description: typeof r.description === 'string' ? r.description : ''});
  }
  return out.slice(0, limit);
}

/** The people whose login or name has the query. */
export async function searchServerUsers(app: App, query: string, signal: AbortSignal, limit = 5): Promise<ServerUser[]> {
  const params = new URLSearchParams({q: query.trim(), limit: String(limit)});
  const res = await online<{data?: unknown}>(app, {api: 'v1', path: `/users/search?${params.toString()}`, signal, timeout: 10_000});
  const out: ServerUser[] = [];
  for (const u of Array.isArray(res?.data) ? res.data as {id?: unknown; login?: unknown; full_name?: unknown}[] : []) {
    if (typeof u.id !== 'number' || typeof u.login !== 'string') continue;
    out.push({id: u.id, login: u.login, fullName: typeof u.full_name === 'string' ? u.full_name : ''});
  }
  return out;
}
