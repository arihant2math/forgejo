// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useEffect, useRef, useState} from 'react';
import {useApp} from '../../app/store.ts';
import {reach} from '../../app/online.ts';
import {codeSource, type CodeSource, NotCached} from '../../code/source.ts';
import type {RefTable} from '../../code/refs.ts';
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

export function refTable(pool: Pool, repoId: number): RefTable {
  const branches = new Map<string, string>();
  const tags = new Map<string, string>();
  for (const b of pool.model('Branch').by('repo_id', repoId)) {
    if (!b.get('is_deleted')) branches.set(b.get('name'), b.get('commit_id'));
  }
  for (const r of pool.model('Release').by('repo_id', repoId)) {
    if (!r.get('draft') && r.get('sha')) tags.set(r.get('tag_name'), r.get('sha'));
  }
  const defaultBranch = pool.model('Repository').get(repoId)?.get('default_branch') ?? '';
  return {branches, tags, defaultBranch};
}

/** Observes group membership to detect whether code refs are loaded. */
export function hasRefs(pool: Pool, repoId: number): boolean {
  return pool.model('Branch').by('repo_id', repoId).size > 0;
}
