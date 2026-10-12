// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {online, send} from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import {parseServerHits} from './server.ts';
import {formatIssueReference} from '../home/IssueReference.tsx';

import type {DiscoverySearch} from './params.ts';
export {discoverySearch, kinds, type Kind, type DiscoverySearch} from './params.ts';
/** `state` and `merged` are set for issues and pull requests only. */
export interface ResultRow {id: number; title: string; detail: string; path: string; state?: string; merged?: boolean}
export interface ResultPage {rows: ResultRow[]; total: number}

const PER_PAGE = 50;

export async function discover(app: App, search: DiscoverySearch, signal: AbortSignal): Promise<ResultPage> {
  const params = new URLSearchParams({q: search.q, type: search.type, page: String(search.page), sort: search.sort});
  if (search.type !== 'issues' && search.type !== 'pulls') {
    if (search.type === 'repositories') {
      if (search.archived) params.set('archived', search.archived);
      if (search.language) params.set('language', search.language);
    }
    const result = await online<ResultPage>(app, {api: 'sync', path: `/discovery?${params}`, signal});
    return result ?? {rows: [], total: 0};
  }
  params.set('type', search.type === 'pulls' ? 'pulls' : 'issues');
  params.set('state', search.state);
  params.set('sort', search.sort === 'created' ? 'latest' : 'recentupdate');
  params.set('order', 'desc');
  params.set('limit', String(PER_PAGE));
  const result = await send<unknown>(app, {api: 'v1', path: `/repos/issues/search?${params}`, signal});
  const rows = parseServerHits(result.value).map((hit): ResultRow => ({id: hit.id, title: hit.title, detail: formatIssueReference(hit.fullName, hit.number), state: hit.state, merged: hit.merged,
    path: `/${encodeURIComponent(hit.owner)}/${encodeURIComponent(hit.repo)}/${hit.pull ? 'pulls' : 'issues'}/${String(hit.number)}`}));
  return {rows, total: result.totalCount ?? rows.length};
}

function words(q: string): (text: string) => boolean {
  const ws = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (text) => ws.every((word) => text.toLowerCase().includes(word));
}

type Matches = {kind: 'repositories'; rows: Entity<'Repository'>[]} | {kind: 'issues'; rows: Entity<'Issue'>[]} | {kind: 'users'; rows: Entity<'User'>[]};

/** Unsorted matches on this device: counting needs no order. */
function localMatches(pool: Pool, search: DiscoverySearch): Matches {
  const matches = words(search.q);
  if (search.type === 'repositories') {
    return {kind: 'repositories', rows: [...pool.model('Repository').all()].filter((e) => {
      const r = e.data;
      return matches(`${r.full_name} ${r.description}`) && (!search.archived || r.archived === (search.archived === 'true'));
    })};
  }
  if (search.type === 'issues' || search.type === 'pulls') {
    return {kind: 'issues', rows: [...pool.model('Issue').all()].filter((e) => {
      const i = e.data;
      return i.is_pull === (search.type === 'pulls') && (search.state === 'all' || i.state === search.state) && matches(i.title);
    })};
  }
  return {kind: 'users', rows: [...pool.model('User').all()].filter((e) => (e.data.type === 'organization') === (search.type === 'organizations') && matches(`${e.data.login} ${e.data.full_name}`))};
}

export function localCount(app: App, search: DiscoverySearch): number {
  const pool = app.session?.data.pool;
  return pool ? localMatches(pool, search).rows.length : 0;
}

/** Only data already on this device; unavailable language metadata is not guessed. */
export function localDiscovery(app: App, search: DiscoverySearch): ResultPage {
  const pool = app.session?.data.pool;
  if (!pool) return {rows: [], total: 0};
  const found = localMatches(pool, search);
  const from = (search.page - 1) * PER_PAGE;
  let rows: ResultRow[];
  if (found.kind === 'repositories') {
    rows = found.rows.map((e) => e.data)
      .sort((a, b) => search.sort === 'stars' ? b.stars_count - a.stars_count : search.sort === 'alpha' ? a.full_name.localeCompare(b.full_name) : (search.sort === 'created' ? b.created_at.localeCompare(a.created_at) : b.updated_at.localeCompare(a.updated_at)))
      .slice(from, from + PER_PAGE)
      .map((r) => ({id: r.id, title: r.full_name, detail: r.description, path: `/${encodeURIComponent(r.owner_name)}/${encodeURIComponent(r.name)}`}));
  } else if (found.kind === 'issues') {
    rows = found.rows.map((e) => e.data)
      .sort((a, b) => search.sort === 'created' ? b.created_at.localeCompare(a.created_at) : b.updated_at.localeCompare(a.updated_at))
      .slice(from, from + PER_PAGE)
      .flatMap((i) => {
        const r = pool.model('Repository').get(i.repo_id)?.data;
        const merged = i.is_pull && [...pool.model('PullRequest').by('issue_id', i.id)].some((p) => p.data.merged);
        return r ? [{id: i.id, title: i.title, detail: formatIssueReference(r.full_name, i.number), state: i.state, merged, path: `/${encodeURIComponent(r.owner_name)}/${encodeURIComponent(r.name)}/${i.is_pull ? 'pulls' : 'issues'}/${String(i.number)}`}] : [];
      });
  } else {
    rows = found.rows.map((e) => e.data)
      .sort((a, b) => a.login.localeCompare(b.login))
      .slice(from, from + PER_PAGE)
      .map((u) => ({id: u.id, title: u.login, detail: u.full_name, path: `/${encodeURIComponent(u.login)}`}));
  }
  return {total: found.rows.length, rows};
}
