// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Resolve workspace repositories from the pool or IndexedDB; use the API for external repositories, then hold their group.

import {apiRepoPath} from './paths.ts';
import {useEffect} from 'react';
import {repoGroup} from '../data/models.ts';
import type {Repository} from '../protocol/types.gen.ts';
import type {Data} from '../sync/data.ts';
import {online, RequestFailed} from './api.ts';
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

/** API v1's answer about a repository, as far as the app uses it. */
export interface RepoAnswer {
  id: number;
  permissions?: {admin?: boolean; push?: boolean} | undefined;
}

const answers = new Map<string, Promise<RepoAnswer | undefined>>();
/** Confirmed 404s (also repositories hidden from the viewer). */
const absent = new Set<string>();

const repoKey = (owner: string, name: string) => `${owner}/${name}`.toLowerCase();

/**
 * GET /repos/{owner}/{name}, one request for every caller; an answer is kept for the page's lifetime.
 * Undefined when not found or not reachable, and asked again next time: a repository can be created or shared later.
 */
export function fetchRepo(app: App, owner: string, name: string): Promise<RepoAnswer | undefined> {
  const key = repoKey(owner, name);
  const asked = answers.get(key);
  if (asked) return asked;
  const forget = () => {
    if (answers.get(key) === p) answers.delete(key);
  };
  const p = online<{id?: unknown; permissions?: RepoAnswer['permissions']}>(app, {
    api: 'v1', path: apiRepoPath(owner, name), timeout: 10_000,
  }).then((r) => {
    absent.delete(key);
    if (typeof r?.id === 'number' && r.id > 0) return {id: r.id, permissions: r.permissions};
    forget();
    return undefined;
  }, (err: unknown) => {
    if (err instanceof RequestFailed && err.status === 404) absent.add(key);
    else if (err instanceof RequestFailed && err.status > 0) absent.delete(key);
    forget();
    return undefined;
  });
  answers.set(key, p);
  return p;
}

/** Rechecks a 404 online; leaving the pool does not imply deletion. */
export async function repoGone(app: App, owner: string, name: string): Promise<boolean> {
  const key = repoKey(owner, name);
  const before = answers.get(key);
  answers.delete(key);
  const id = await lookup(app, owner, name);
  if (id === undefined && !absent.has(key) && before && !answers.has(key)) answers.set(key, before);
  return id === undefined && absent.has(key);
}

/** How long a route waits for a repository outside the pool (the request goes on, for the next visit). */
const LOOKUP_WAIT = 3000;

function fetchRepoId(app: App, owner: string, name: string): Promise<number | undefined> {
  return Promise.race([
    lookup(app, owner, name),
    new Promise<undefined>((resolve) => setTimeout(resolve, LOOKUP_WAIT)),
  ]);
}

async function lookup(app: App, owner: string, name: string): Promise<number | undefined> {
  if (!app.session || (!answers.has(repoKey(owner, name)) && !navigator.onLine)) return undefined;
  return (await fetchRepo(app, owner, name))?.id;
}

/** Resolves the id and hydrates its group from IndexedDB. */
export async function loadRepo(app: App, owner: string, name: string): Promise<RepoMatch> {
  const s = app.session;
  if (!s) return {repoId: undefined};
  const repoId = findRepo(s.data, owner, name) ?? await fetchRepoId(app, owner, name);
  if (repoId !== undefined) await s.data.hydrate([repoGroup(repoId)]);
  return repoId === undefined && absent.has(repoKey(owner, name)) ? {repoId, notFound: true} : {repoId};
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
