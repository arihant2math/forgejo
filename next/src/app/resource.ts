// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Server data outside the pool: the first frame from memory, then IndexedDB, then Forgejo. A stale value stays
// while it is asked again; transient failures are retried while connected and again on reconnect.

import {useCallback, useEffect, useEffectEvent, useRef, useState} from 'react';
import {type CodeCache, sessionCache} from '../code/cache.ts';
import {failureText} from './api.ts';
import {connectivity, useReach} from './online.ts';
import {type App, type Session, useApp} from './store.ts';

export type LoadFailure =
  /** No value and no answer: the browser is offline, or the content is not on this device. */
  | {state: 'offline'}
  /** `error` is user-facing (failureText); 401 means signed out. */
  | {state: 'error'; error: string; status: number};

/** What a view shows instead of a value; `reload` asks again. */
export type Unready = {state: 'loading'} | (LoadFailure & {reload?: (() => void) | undefined});

export type Resource<T> = {
  /** Whether the value is this visit's server answer rather than a cached one. */
  fresh: boolean;
  /** Changes the shown and cached value at once (optimistic writes). */
  update: (fn: (v: T | undefined) => T) => void;
  reload: () => void;
} & (
  | {state: 'ready'; value: T}
  | {state: 'loading'; value: undefined}
  | {state: 'offline'; value: undefined}
  | {state: 'error'; value: undefined; error: string; status: number}
);

export interface ResourceOptions<T> {
  /** The caller's own synchronous cache, filled by its loader; without it the session cache keeps the answers. */
  peek?: (() => T | undefined) | undefined;
  /** What IndexedDB keeps of an answer (memory keeps all of it), e.g. without secrets. */
  store?: ((v: T) => unknown) | undefined;
  /** The key names content that never changes: a value in hand is final. */
  immutable?: boolean | undefined;
}

/** Pauses before asking again after a transient failure while connected. */
export const AUTO_RETRY_MS = [1000, 3000] as const;

/** A prefetched answer this recent is shown as fresh instead of being asked again. */
const PREFETCH_FRESH_MS = 30_000;

export function transientFailure(err: unknown): boolean {
  if (err instanceof Error && err.name === 'NotCached') return true;
  const status = (err as {status?: unknown} | null)?.status;
  return typeof status === 'number' && (status === 0 || status === 408 || status === 429 || status >= 500);
}

/** How a failed read without a value is shown; the raw message only reaches the console. */
export function failureOf(err: unknown): LoadFailure {
  if (err instanceof Error && err.name === 'NotCached') return {state: 'offline'};
  if (err instanceof Error && err.name === 'SignedOut') return {state: 'error', error: 'You are signed out.', status: 401};
  const raw = (err as {status?: unknown} | null)?.status;
  const status = typeof raw === 'number' ? raw : 0;
  if (status === 0 && !connectivity.online) return {state: 'offline'};
  return {state: 'error', error: failureText(err), status};
}

interface Shared {
  inflight: Map<string, Promise<unknown>>;
  /** When a key was last answered, by a view or by loadResource. */
  answered: Map<string, number>;
  /** Keys answered by loadResource and not asked by a view since: a view mounting soon after shows them as fresh. */
  prefetched: Set<string>;
}

const shared = new WeakMap<Session, Shared>();

function sharedOf(s: Session): Shared {
  let v = shared.get(s);
  if (!v) shared.set(s, v = {inflight: new Map(), answered: new Map(), prefetched: new Set()});
  return v;
}

function cacheOf(app: App): CodeCache | undefined {
  return app.session && sessionCache(app.session.data.db);
}

function keep<T>(cache: CodeCache | undefined, key: string, v: T, store: ((v: T) => unknown) | undefined): void {
  if (!cache) return;
  cache.put(key, store ? store(v) : v);
  if (store) cache.remember(key, v);
}

/**
 * Asks Forgejo once for a key and keeps the answer in the session cache, outside React (route prefetch,
 * loops over many keys). Concurrent calls share one request; a recent answer is reused.
 */
export function loadResource<T>(app: App, key: string, load: () => Promise<T>, store?: (v: T) => unknown): Promise<T> {
  const s = app.session;
  if (!s) return load();
  const {inflight, answered, prefetched} = sharedOf(s);
  const cache = cacheOf(app);
  const hit = cache?.peek<T>(key);
  if (hit !== undefined && Date.now() - (answered.get(key) ?? -Infinity) < PREFETCH_FRESH_MS) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = load().then((v) => {
    keep(cache, key, v, store);
    answered.set(key, Date.now());
    prefetched.add(key);
    return v;
  }).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

interface State<T> {
  key: string | undefined;
  value: T | undefined;
  fresh: boolean;
  failure: LoadFailure | undefined;
}

/**
 * One server read for a view. An undefined key defers it. Without `peek`, answers go to the session cache
 * (memory and IndexedDB) and every visit asks again; with `immutable`, a value in hand is never asked again.
 */
export function useResource<T>(key: string | undefined, load: (signal: AbortSignal) => Promise<T>, opts: ResourceOptions<T> = {}): Resource<T> {
  const app = useApp();
  const cache = cacheOf(app);
  const {peek, store, immutable = false} = opts;
  const own = peek === undefined;
  const initial = (): State<T> => {
    if (key === undefined) return {key, value: undefined, fresh: false, failure: undefined};
    const value = own ? cache?.peek<T>(key) : peek();
    const sh = own && app.session ? sharedOf(app.session) : undefined;
    const at = sh?.prefetched.has(key) ? sh.answered.get(key) : undefined;
    return {key, value, fresh: value !== undefined && at !== undefined && Date.now() - at < PREFETCH_FRESH_MS, failure: undefined};
  };
  const [s, setS] = useState(initial);
  // Read the new key's cache during render, so a view never shows the previous key's value or a needless placeholder.
  let cur = s;
  if (s.key !== key) {
    cur = initial();
    setS(cur);
  }
  const r = useReach();
  const [round, setRound] = useState(0);
  const tries = useRef({key, n: 0});
  const done = cur.value !== undefined && (immutable || (cur.fresh && round === 0));

  const loadNow = useEffectEvent((signal: AbortSignal) => load(signal));
  /** A prefetch of the key still running, which the view waits for instead of asking again. */
  const prefetchOf = useEffectEvent(() => (own && app.session && key !== undefined ? sharedOf(app.session).inflight.get(key) as Promise<T> | undefined : undefined));
  const keepNow = useEffectEvent((v: T, prefetched: boolean) => {
    if (!own || key === undefined) return;
    if (!prefetched) keep(cache, key, v, store);
    if (!app.session) return;
    const sh = sharedOf(app.session);
    sh.answered.set(key, Date.now());
    sh.prefetched.delete(key);
  });

  useEffect(() => {
    if (key === undefined || done) return undefined;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prefetch = prefetchOf();
    void (async () => {
      if (!prefetch && own && cache && cache.peek(key) === undefined) {
        const stored = await cache.get<T>(key);
        if (ctl.signal.aborted) return;
        if (stored !== undefined) {
          setS((old) => (old.key === key && old.value === undefined ? {key, value: stored, fresh: false, failure: undefined} : old));
          if (immutable) return;
        }
      }
      // Offline the browser cannot ask; reconnecting runs this again.
      if (r === 'offline') return;
      try {
        const v = await (prefetch ?? loadNow(ctl.signal));
        if (ctl.signal.aborted) return;
        tries.current = {key, n: 0};
        keepNow(v, prefetch !== undefined);
        setS({key, value: v, fresh: true, failure: undefined});
      } catch (err) {
        if (ctl.signal.aborted) return;
        if (tries.current.key !== key) tries.current = {key, n: 0};
        const pause = r === 'online' && transientFailure(err) ? AUTO_RETRY_MS[tries.current.n] : undefined;
        if (pause !== undefined) {
          tries.current.n++;
          timer = setTimeout(() => {
            setRound((n) => n + 1);
          }, pause);
          return;
        }
        // A stale value survives a transient failure; a refusal (403, 404) replaces it.
        setS((old) => (old.key !== key ? old : old.value !== undefined && transientFailure(err) ? {...old, fresh: false} :
          {key, value: undefined, fresh: false, failure: failureOf(err)}));
      }
    })();
    return () => {
      ctl.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load, peek and store belong to the key
  }, [cache, key, round, r, done]);

  const update = (fn: (v: T | undefined) => T) => {
    setS((old) => {
      if (old.key !== key) return old;
      const v = fn(old.value);
      if (own && key !== undefined) keep(cache, key, v, store);
      return {...old, value: v, failure: undefined};
    });
  };
  const reload = useCallback(() => {
    tries.current = {key, n: 0};
    setS((old) => (old.key === key ? {...old, failure: undefined} : old));
    setRound((n) => n + 1);
  }, [key]);

  const common = {fresh: cur.fresh, update, reload};
  if (cur.value !== undefined) return {...common, state: 'ready', value: cur.value};
  if (cur.failure?.state === 'error') return {...common, value: undefined, ...cur.failure};
  if (cur.failure || r !== 'online') return {...common, state: 'offline', value: undefined};
  return {...common, state: 'loading', value: undefined};
}
