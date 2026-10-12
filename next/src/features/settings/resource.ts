// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Stale-while-revalidate settings use repository-scoped cache keys so revocation purges them with content.

import {useCallback, useEffect, useEffectEvent, useState} from 'react';
import {RequestFailed} from '../../app/api.ts';
import {connectivity} from '../../app/online.ts';
import {useApp} from '../../app/store.ts';
import {codeSource} from '../../code/source.ts';

export type ResourceState = 'loading' | 'ready' | 'offline' | 'error';

export interface Resource<T> {
  /** Undefined before the first answer; may contain a prior visit's answer. */
  value: T | undefined;
  state: ResourceState;
  /** Whether the value is this visit's server answer rather than cached data. */
  fresh: boolean;
  error?: string | undefined;
  status?: number | undefined;
  /** Optimistically update both displayed and cached values. */
  update: (fn: (v: T | undefined) => T) => void;
  reload: () => void;
}

export function settingsKey(repoId: number, what: string): string {
  return `settings:${String(repoId)}:${what}`;
}

/** `store` filters IndexedDB data; memory retains the full answer, including webhook authorization. */
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

  const keep = (v: T) => {
    if (!cache) return;
    cache.put(key, store ? store(v) : v);
    if (store) cache.remember(key, v);
  };

  const fetchNow = useEffectEvent((signal: AbortSignal) => fetcher(signal));
  const keepNow = useEffectEvent((v: T) => {
    keep(v);
  });

  useEffect(() => {
    const run = {live: true};
    const ctl = new AbortController();
    void (async () => {
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
        // Preserve stale data on network failure, but replace it on access refusal (403/404).
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

/** Limit concurrent calls to `limit`. */
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
