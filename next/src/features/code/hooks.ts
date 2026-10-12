// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {compareStructural, computed, type IComputedValue} from 'mobx';
import {useEffect, useRef, useState} from 'react';
import {useApp} from '../../app/store.ts';
import {reach} from '../../app/online.ts';
import {codeSource, type CodeSource, NotCached} from '../../code/source.ts';
import type {RefTable} from '../../code/refs.ts';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';

export function useSource(): CodeSource {
  const src = codeSource(useApp());
  if (!src) throw new Error('code views need a session');
  return src;
}

export type Loaded<T> =
  | {state: 'loading'}
  | {state: 'ready'; value: T}
  /** No cached value and no server answer; includes transport failures while connected. */
  | {state: 'offline'; retry?: (() => void) | undefined}
  | {state: 'error'; message: string; status: number; retry?: (() => void) | undefined};

/** Retry delays in milliseconds for transient reads while connected. */
export const AUTO_RETRY_MS = [1000, 3000] as const;

export function transientFailure(err: unknown): boolean {
  if (err instanceof NotCached) return true;
  const status = (err as {status?: unknown} | null)?.status;
  return typeof status === 'number' && (status === 0 || status === 408 || status === 429 || status >= 500);
}

/** Peek synchronously by immutable key; undefined key defers loading. */
export function useLoad<T>(key: string | undefined, peek: () => T | undefined, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{key: string | undefined; loaded: Loaded<T>}>(() => {
    const v = key === undefined ? undefined : peek();
    return {key, loaded: v === undefined ? {state: 'loading'} : {state: 'ready', value: v}};
  });
  // Peek during render to avoid showing the previous key or a placeholder.
  let current = state;
  if (state.key !== key) {
    const v = key === undefined ? undefined : peek();
    current = {key, loaded: v === undefined ? {state: 'loading'} : {state: 'ready', value: v}};
    setState(current);
  }
  const online = reach(useApp().session?.data.status.connection) === 'online';
  const done = current.loaded.state === 'ready';
  const [attempt, setAttempt] = useState(0);
  const tries = useRef({key, n: 0});
  useEffect(() => {
    if (key === undefined || done) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    load().then((value) => {
      if (live) setState({key, loaded: {state: 'ready', value}});
    }, (err: unknown) => {
      if (!live) return;
      if (tries.current.key !== key) tries.current = {key, n: 0};
      const pause = online && transientFailure(err) ? AUTO_RETRY_MS[tries.current.n] : undefined;
      if (pause !== undefined) {
        tries.current.n++;
        timer = setTimeout(() => {
          setAttempt((n) => n + 1);
        }, pause);
        return;
      }
      if (err instanceof NotCached) setState({key, loaded: {state: 'offline'}});
      else {
        const status = (err as {status?: unknown}).status;
        setState({key, loaded: {state: 'error', message: err instanceof Error ? err.message : String(err), status: typeof status === 'number' ? status : 0}});
      }
    });
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load/peek are per key
  }, [key, done, online, attempt]);
  if (!online && current.loaded.state === 'loading') return {state: 'offline'};
  const loaded = current.loaded;
  if (loaded.state === 'offline' || (loaded.state === 'error' && transientFailure(loaded))) {
    return {...loaded, retry: () => {
      tries.current = {key, n: 0};
      setState({key, loaded: {state: 'loading'}});
      setAttempt((n) => n + 1);
    }};
  }
  return loaded;
}

export interface RefIndex extends RefTable {
  /** The default branch first, then by name. */
  branchNames: readonly string[];
  /** Newest version first. */
  tagNames: readonly string[];
}

function buildRefs(pool: Pool, repoId: number): RefIndex {
  const branches = new Map<string, string>();
  const tags = new Map<string, string>();
  for (const b of pool.model('Branch').by('repo_id', repoId)) {
    if (!b.get('is_deleted')) branches.set(b.get('name'), b.get('commit_id'));
  }
  for (const r of pool.model('Release').by('repo_id', repoId)) {
    if (!r.get('draft') && r.get('sha')) tags.set(r.get('tag_name'), r.get('sha'));
  }
  const defaultBranch = pool.model('Repository').get(repoId)?.get('default_branch') ?? '';
  const branchNames = [...branches.keys()].sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : a.localeCompare(b)));
  const tagNames = [...tags.keys()].sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));
  return {branches, tags, defaultBranch, branchNames, tagNames};
}

const refIndexes = new WeakMap<Pool, Map<number, IComputedValue<RefIndex>>>();

/** One shared derivation per repository, so observers depend on it instead of on every branch and release. */
export function refTable(pool: Pool, repoId: number): RefIndex {
  let byRepo = refIndexes.get(pool);
  if (!byRepo) refIndexes.set(pool, byRepo = new Map<number, IComputedValue<RefIndex>>());
  let c = byRepo.get(repoId);
  if (!c) byRepo.set(repoId, c = computed(() => buildRefs(pool, repoId), {equals: compareStructural}));
  return c.get();
}

const branchMaps = new WeakMap<Pool, Map<number, IComputedValue<ReadonlyMap<string, Entity<'Branch'>>>>>();

/** Live branches by name. */
export function branchByName(pool: Pool, repoId: number): ReadonlyMap<string, Entity<'Branch'>> {
  let byRepo = branchMaps.get(pool);
  if (!byRepo) branchMaps.set(pool, byRepo = new Map<number, IComputedValue<ReadonlyMap<string, Entity<'Branch'>>>>());
  let c = byRepo.get(repoId);
  if (!c) {
    byRepo.set(repoId, c = computed(() => {
      const out = new Map<string, Entity<'Branch'>>();
      for (const b of pool.model('Branch').by('repo_id', repoId)) if (!b.get('is_deleted')) out.set(b.get('name'), b);
      return out;
    }, {equals: (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)}));
  }
  return c.get();
}

/** Observes group membership to detect whether code refs are loaded. */
export function hasRefs(pool: Pool, repoId: number): boolean {
  return pool.model('Branch').by('repo_id', repoId).size > 0;
}

/** Reads a file and highlights it at idle priority in the code view's workers, ahead of its view. */
export function warmFile(src: CodeSource, base: string, repoId: number, sha: string, path: string, size?: number): void {
  void src.blob(repoId, sha, path, size).then(async (c) => {
    if (c.kind !== 'text') return;
    (await import('../../code/PierreProvider.tsx')).primeFile(base, sha, path, c.text);
  }).catch(() => undefined);
}
