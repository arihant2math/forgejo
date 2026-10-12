// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Resolve workspace repositories from the pool or IndexedDB; use the API for external repositories, then hold their group.

import {useEffect} from 'react';
import type {Repository} from '../protocol/types.gen.ts';
import type {Data} from '../sync/data.ts';
import {sitePath} from './config.ts';
import type {App} from './store.ts';

export interface RepoMatch {
  /** undefined: unknown here (offline and not synced, or no such repository). */
  repoId: number | undefined;
  /** A confirmed 404, including repositories hidden from the viewer. */
  notFound?: boolean;
}

/** Finds a repository by owner and name in the pool or the peeked records (names are case-insensitive). */
export function findRepo(data: Data, owner: string, name: string): number | undefined {
  const full = `${owner}/${name}`;
  const store = data.pool.model('Repository');
  for (const e of store.by('full_name', full)) return e.id;
  const lower = full.toLowerCase();
  const match = (r: Repository) => r.full_name.toLowerCase() === lower;
  for (const e of store.all()) if (match(e.data)) return e.id;
  for (const r of data.peek('Repository').values()) if (match(r)) return r.id;
  return undefined;
}

/** A repository's `owner/name` as Forgejo spells it (pool, else the peeked records). */
export function repoFullName(app: App, repoId: number): string | undefined {
  const data = app.session?.data;
  return data?.pool.model('Repository').get(repoId)?.data.full_name ?? data?.peek('Repository').get(repoId)?.full_name;
}

const looked = new Map<string, number | undefined>();
const absent = new Set<string>();

/** Rechecks a 404 online; leaving the pool does not imply deletion. */
export async function repoGone(app: App, owner: string, name: string): Promise<boolean> {
  const key = `${owner}/${name}`.toLowerCase();
  const before = looked.get(key);
  looked.delete(key);
  const id = await lookup(app, owner, name);
  if (id === undefined && !absent.has(key) && before !== undefined) looked.set(key, before);
  return id === undefined && absent.has(key);
}

const LOOKUP_TIMEOUT = 3000;

function fetchRepoId(app: App, owner: string, name: string): Promise<number | undefined> {
  return Promise.race([
    lookup(app, owner, name),
    new Promise<undefined>((resolve) => setTimeout(resolve, LOOKUP_TIMEOUT)),
  ]);
}

async function lookup(app: App, owner: string, name: string): Promise<number | undefined> {
  const key = `${owner}/${name}`.toLowerCase();
  if (looked.has(key)) return looked.get(key);
  const s = app.session;
  if (!s || !navigator.onLine) return undefined;
  try {
    const token = await s.auth.token();
    const res = await fetch(sitePath(app.config, `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`), {
      headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'}, credentials: 'omit', signal: AbortSignal.timeout(LOOKUP_TIMEOUT),
    });
    if (res.status === 404) absent.add(key);
    else absent.delete(key);
    const id = res.ok ? (await res.json() as {id?: unknown}).id : undefined;
    const found = typeof id === 'number' && id > 0 ? id : undefined;
    // Retry 404s and errors on future visits: a repository can be created or shared later.
    if (found !== undefined) looked.set(key, found);
    return found;
  } catch {
    return undefined;
  }
}

/** Resolves the id and hydrates its group from IndexedDB. */
export async function loadRepo(app: App, owner: string, name: string): Promise<RepoMatch> {
  const s = app.session;
  if (!s) return {repoId: undefined};
  const repoId = findRepo(s.data, owner, name) ?? await fetchRepoId(app, owner, name);
  if (repoId !== undefined) await s.data.hydrate([`repo:${String(repoId)}`]);
  return repoId === undefined && absent.has(`${owner}/${name}`.toLowerCase()) ? {repoId, notFound: true} : {repoId};
}

/** Holds the group live for the component's lifetime, loading it if needed. */
export function useHold(data: Data, group: string | undefined): void {
  useEffect(() => {
    if (!group) return undefined;
    data.hold(group);
    return () => {
      data.release(group);
    };
  }, [data, group]);
}
