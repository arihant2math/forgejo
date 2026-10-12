// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ComponentType, type ReactNode, useEffect, useReducer} from 'react';

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

/** Avoids Suspense's reveal delay for keyboard overlays; renders fallback until loaded. */
export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode = null): LazyComponent<P> {
  const chunk = cachedLoader(load);
  function Lazy(props: P) {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      let mounted = true;
      if (!chunk.loaded) {
        chunk.preload().then(() => {
          if (mounted) rerender();
        }, (err: unknown) => {
          if (mounted) console.error('loading a chunk failed', err);
        });
      }
      return () => { mounted = false; };
    }, []);
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
