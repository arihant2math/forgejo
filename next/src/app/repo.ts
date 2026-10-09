// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Repository routes (/{owner}/{repo}/…): from the names in the URL to the
// repository's id and group. The pool (or, before hydration finished, what
// IndexedDB held: Data.peek) answers for the workspace; a repository outside
// it is looked up with API v1 once (online only) and then loaded on demand
// by holding its group.

import {useEffect} from 'react';
import type {Repository} from '../protocol/types.gen.ts';
import type {Data} from '../sync/data.ts';
import {sitePath} from './config.ts';
import type {App} from './store.ts';

export interface RepoMatch {
  /** undefined: unknown here (offline and not synced, or no such repository). */
  repoId: number | undefined;
  /** Forgejo answered that there is no such repository (or none the viewer can see): no classic page either. */
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

const looked = new Map<string, number | undefined>();
/** Repositories Forgejo answered 404 for (asked again on the next visit: it may be created or shared later). */
const absent = new Set<string>();

/** A loader waits at most this long for the network: the page then renders (render first). */
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
    // Remember a found repository only; a 404 (it may be created or shared later) and errors are asked again.
    if (found !== undefined) looked.set(key, found);
    return found;
  } catch {
    return undefined;
  }
}

/** The loader of repository routes: the id, with its group hydrated from IndexedDB. */
export async function loadRepo(app: App, owner: string, name: string): Promise<RepoMatch> {
  const s = app.session;
  if (!s) return {repoId: undefined};
  const repoId = findRepo(s.data, owner, name) ?? await fetchRepoId(app, owner, name);
  if (repoId !== undefined) await s.data.hydrate([`repo:${String(repoId)}`]);
  return repoId === undefined && absent.has(`${owner}/${name}`.toLowerCase()) ? {repoId, notFound: true} : {repoId};
}

/** Holds a group while the component is mounted: it is loaded if needed and kept live. */
export function useHold(data: Data, group: string | undefined): void {
  useEffect(() => {
    if (!group) return undefined;
    data.hold(group);
    return () => {
      data.release(group);
    };
  }, [data, group]);
}
