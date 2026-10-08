// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What code views share: the session's code source, loading by an immutable
// key (first frame from memory when the value is there: no placeholder for
// content seen before), and the ref table from the pool.

import {useEffect, useState} from 'react';
import {useApp} from '../../app/store.ts';
import {connectivity} from '../../app/online.ts';
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
  /** Offline (or unreachable) and not on this device. */
  | {state: 'offline'}
  | {state: 'error'; message: string; status: number};

/**
 * A value addressed by an immutable key: `peek` answers synchronously when it
 * is in memory (the view paints it in its first frame), else `load` runs
 * once per key. undefined key: nothing to load (yet).
 */
export function useLoad<T>(key: string | undefined, peek: () => T | undefined, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{key: string | undefined; loaded: Loaded<T>}>(() => {
    const v = key === undefined ? undefined : peek();
    return {key, loaded: v === undefined ? {state: 'loading'} : {state: 'ready', value: v}};
  });
  // A new key: peek synchronously during render (no frame of the old value or a placeholder).
  let current = state;
  if (state.key !== key) {
    const v = key === undefined ? undefined : peek();
    current = {key, loaded: v === undefined ? {state: 'loading'} : {state: 'ready', value: v}};
    setState(current);
  }
  const online = connectivity.online;
  const done = current.loaded.state === 'ready';
  useEffect(() => {
    if (key === undefined || done) return undefined;
    let live = true;
    load().then((value) => {
      if (live) setState({key, loaded: {state: 'ready', value}});
    }, (err: unknown) => {
      if (!live) return;
      if (err instanceof NotCached) setState({key, loaded: {state: 'offline'}});
      else {
        const status = (err as {status?: unknown}).status;
        setState({key, loaded: {state: 'error', message: err instanceof Error ? err.message : String(err), status: typeof status === 'number' ? status : 0}});
      }
    });
    return () => {
      live = false;
    };
    // `online`: back online, a key that failed offline loads again.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load/peek are per key
  }, [key, done, online]);
  return current.loaded;
}

/** Branches and tags → SHA, and the default branch (observes the repository's branches and releases). */
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

/** Whether the pool has the repository's code refs at all (its group loaded with the code unit). Observes membership. */
export function hasRefs(pool: Pool, repoId: number): boolean {
  return pool.model('Branch').by('repo_id', repoId).size > 0;
}
