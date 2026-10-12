// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ComponentType, type ReactNode, useEffect, useReducer, useRef} from 'react';

export interface LazyComponent<P extends object> {
  (props: P): ReactNode;
  preload(): Promise<void>;
}

/** Loads once; a failed load is retried by the next `preload`. */
function cachedLoader<T>(load: () => Promise<T>): {loaded: T | undefined; preload: () => Promise<void>} {
  let loading: Promise<void> | undefined;
  const chunk = {
    loaded: undefined as T | undefined,
    preload: () => loading ??= load().then((value) => {
      chunk.loaded = value;
    }, (err: unknown) => {
      loading = undefined;
      throw err;
    }),
  };
  return chunk;
}

/** Avoids Suspense's reveal delay for keyboard overlays; renders fallback until loaded, retrying once back online. */
export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode = null): LazyComponent<P> {
  const chunk = cachedLoader(load);
  function Lazy(props: P) {
    const [attempt, rerender] = useReducer((n: number) => n + 1, 0);
    const failedOffline = useRef(false);
    useEffect(() => {
      let mounted = true;
      const retry = () => { if (mounted) rerender(); };
      if (!chunk.loaded) {
        chunk.preload().then(retry, (err: unknown) => {
          if (!mounted) return;
          // Offline before the worker cached the chunk is not an error. Some browsers keep a failed module for the
          // document's lifetime, so the retry once back online may fail the same way: the next page load has it.
          if (!navigator.onLine) {
            failedOffline.current = true;
            window.addEventListener('online', retry, {once: true});
          } else if (!failedOffline.current) console.error('loading a chunk failed', err);
        });
      }
      return () => {
        mounted = false;
        window.removeEventListener('online', retry);
      };
    }, [attempt]);
    return chunk.loaded ? <chunk.loaded {...props}/> : fallback;
  }
  return Object.assign(Lazy, {preload: chunk.preload});
}

export function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, {timeout: 2000});
  else setTimeout(fn, 200);
}

/** Preloaded before route render; load failures propagate to the router's error state, including at boot. */
export function lazyView<K extends string = 'default'>(
  load: () => Promise<Record<K, ComponentType>>,
  name: K = 'default' as K,
): (() => ReactNode) & {preload: () => Promise<void>} {
  const chunk = cachedLoader<ComponentType>(() => load().then((m) => m[name]));
  function View() {
    if (!chunk.loaded) throw chunk.preload();
    return <chunk.loaded/>;
  }
  return Object.assign(View, {preload: chunk.preload});
}
