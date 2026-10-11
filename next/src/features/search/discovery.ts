// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {online, send} from '../../app/api.ts';
import type {App} from '../../app/store.ts';
import {parseServerHits} from './server.ts';

import type {DiscoverySearch} from './params.ts';
export {discoverySearch, kinds, type Kind, type DiscoverySearch} from './params.ts';
export interface ResultRow {id: number; title: string; detail: string; path: string}
export interface ResultPage {rows: ResultRow[]; total: number}

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
  params.set('limit', '50');
  const result = await send<unknown>(app, {api: 'v1', path: `/repos/issues/search?${params}`, signal});
  const rows = parseServerHits(result.value).map((hit) => ({id: hit.id, title: hit.title, detail: `${hit.fullName} #${String(hit.number)} · ${hit.state}`, path: `/${encodeURIComponent(hit.owner)}/${encodeURIComponent(hit.repo)}/${hit.pull ? 'pulls' : 'issues'}/${String(hit.number)}`}));
  return {rows, total: result.totalCount ?? rows.length};
}

/** Only data already on this device; unavailable language metadata is not guessed. */
export function localDiscovery(app: App, search: DiscoverySearch): ResultPage {
  const pool = app.session?.data.pool;
  if (!pool) return {rows: [], total: 0};
  const words = search.q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word));
  let rows: ResultRow[];
  if (search.type === 'repositories') {
    rows = [...pool.model('Repository').all()].map((e) => e.data)
      .filter((r) => matches(`${r.full_name} ${r.description}`) && (!search.archived || r.archived === (search.archived === 'true')))
      .sort((a, b) => search.sort === 'stars' ? b.stars_count - a.stars_count : search.sort === 'alpha' ? a.full_name.localeCompare(b.full_name) : (search.sort === 'created' ? b.created_at.localeCompare(a.created_at) : b.updated_at.localeCompare(a.updated_at)))
      .map((r) => ({id: r.id, title: r.full_name, detail: r.description, path: `/${encodeURIComponent(r.owner_name)}/${encodeURIComponent(r.name)}`}));
  } else if (search.type === 'issues' || search.type === 'pulls') {
    rows = [...pool.model('Issue').all()].map((e) => e.data)
      .filter((i) => i.is_pull === (search.type === 'pulls') && (search.state === 'all' || i.state === search.state) && matches(i.title))
      .sort((a, b) => search.sort === 'created' ? b.created_at.localeCompare(a.created_at) : b.updated_at.localeCompare(a.updated_at))
      .flatMap((i) => {
        const r = pool.model('Repository').get(i.repo_id)?.data;
        return r ? [{id: i.id, title: i.title, detail: `${r.full_name} #${String(i.number)} · ${i.state}`, path: `/${encodeURIComponent(r.owner_name)}/${encodeURIComponent(r.name)}/${i.is_pull ? 'pulls' : 'issues'}/${String(i.number)}`}] : [];
      });
  } else {
    rows = [...pool.model('User').all()].map((e) => e.data)
      .filter((u) => (u.type === 'organization') === (search.type === 'organizations') && matches(`${u.login} ${u.full_name}`))
      .sort((a, b) => a.login.localeCompare(b.login))
      .map((u) => ({id: u.id, title: u.login, detail: u.full_name, path: `/${encodeURIComponent(u.login)}`}));
  }
  return {total: rows.length, rows: rows.slice((search.page - 1) * 50, search.page * 50)};
}
