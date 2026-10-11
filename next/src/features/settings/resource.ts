// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The settings that are not in the pool (collaborators' exact roles, branch
// protection rules, webhooks, deploy keys) come from API v1 and are kept in
// the code cache (src/code/cache.ts: memory over IndexedDB, keyed
// `settings:<repo>:<what>` so a revoked repository's entries go with its
// content) — stale while revalidated: a page seen before paints its last
// answer in its first frame (memory) or right after (IndexedDB), and is
// asked again on every visit while online. Changes made here update the
// kept answer at once (optimistic), and the next answer replaces it.

import {useCallback, useEffect, useEffectEvent, useState} from 'react';
import {RequestFailed} from '../../app/api.ts';
import {connectivity} from '../../app/online.ts';
import {useApp} from '../../app/store.ts';
import {codeSource} from '../../code/source.ts';

export type ResourceState = 'loading' | 'ready' | 'offline' | 'error';

export interface Resource<T> {
  /** The latest answer (maybe from an earlier visit), or undefined before the first. */
  value: T | undefined;
  state: ResourceState;
  /** Whether `value` is this visit's answer. */
  fresh: boolean;
  error?: string | undefined;
  status?: number | undefined;
  /** A local change (optimistic): applied to the value shown and kept. */
  update: (fn: (v: T | undefined) => T) => void;
  /** Asks again. */
  reload: () => void;
}

export function settingsKey(repoId: number, what: string): string {
  return `settings:${String(repoId)}:${what}`;
}

/**
 * A settings list from API v1, kept for the next visit. `store` is what is written to IndexedDB (a webhook's
 * authorization header stays in memory only); the value in memory is the whole answer.
 */
export function useResource<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>, store?: (v: T) => unknown): Resource<T> {
  const app = useApp();
  const cache = codeSource(app)?.cache;
  const [s, setS] = useState<{key: string; value: T | undefined; state: ResourceState; fresh: boolean; error?: string; status?: number}>(() => {
    const v = cache?.peek<T>(key);
    return {key, value: v, state: v === undefined ? 'loading' : 'ready', fresh: false};
  });
  let current = s;
  if (s.key !== key) {
    const v = cache?.peek<T>(key);
    current = {key, value: v, state: v === undefined ? 'loading' : 'ready', fresh: false};
    setS(current);
  }
  const [round, setRound] = useState(0);
  const online = connectivity.online;

  /** Keeps an answer: all of it in memory, `store`'s part of it in IndexedDB. */
  const keep = (v: T) => {
    if (!cache) return;
    cache.put(key, store ? store(v) : v);
    if (store) cache.remember(key, v);
  };

  const fetchNow = useEffectEvent((signal: AbortSignal) => fetcher(signal));
  const keepNow = useEffectEvent((v: T) => {
    keep(v);
  });

  // Asked on every visit (and again when back online): the kept answer is shown meanwhile.
  useEffect(() => {
    const run = {live: true};
    const ctl = new AbortController();
    void (async () => {
      // A visit after a reload: the last answer from IndexedDB first.
      if (cache && cache.peek(key) === undefined) {
        const stored = await cache.get<T>(key);
        if (run.live && stored !== undefined) {
          setS((old) => (old.key === key && old.value === undefined ? {key, value: stored, state: 'ready', fresh: false} : old));
        }
      }
      if (!navigator.onLine) {
        if (run.live) setS((old) => (old.key === key && old.value === undefined ? {...old, state: 'offline'} : old));
        return;
      }
      try {
        const v = await fetchNow(ctl.signal);
        if (!run.live) return;
        keepNow(v);
        setS({key, value: v, state: 'ready', fresh: true});
      } catch (err) {
        if (!run.live) return;
        const status = err instanceof RequestFailed ? err.status : 0;
        const message = err instanceof Error ? err.message : String(err);
        // Kept answers stay on screen when Forgejo cannot be reached; a refusal (403, 404) replaces them.
        setS((old) => (old.key !== key ? old : status === 0 && old.value !== undefined ? {...old, fresh: false} :
          {key, value: undefined, state: status === 0 && !navigator.onLine ? 'offline' : 'error', fresh: false, error: message, status}));
      }
    })();
    return () => {
      run.live = false;
      ctl.abort();
    };
  }, [cache, key, round, online]);

  const update = (fn: (v: T | undefined) => T) => {
    setS((old) => {
      if (old.key !== key) return old;
      const v = fn(old.value);
      keep(v);
      return {...old, value: v, state: 'ready'};
    });
  };
  const reload = useCallback(() => {
    setRound((r) => r + 1);
  }, []);
  return {...current, update, reload};
}

/** Runs `fn` for each item, at most `limit` at a time (a collaborator's role each: one request per person). */
export async function eachLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return out;
}
