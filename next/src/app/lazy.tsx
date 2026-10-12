// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ComponentType, type ReactNode, useEffect, useReducer} from 'react';

export interface LazyComponent<P extends object> {
  (props: P): ReactNode;
  preload(): Promise<void>;
}

/** Avoids Suspense's reveal delay for keyboard overlays; renders fallback until loaded. */
export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode = null): LazyComponent<P> {
  let Loaded: ComponentType<P> | undefined;
  let loading: Promise<void> | undefined;
  const preload = () => loading ??= load().then((c) => {
    Loaded = c;
  }, (err: unknown) => {
    loading = undefined;
    throw err;
  });
  function Lazy(props: P) {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
      let mounted = true;
      if (!Loaded) {
        preload().then(() => {
          if (mounted) rerender();
        }, (err: unknown) => {
          if (mounted) console.error('loading a chunk failed', err);
        });
      }
      return () => { mounted = false; };
    }, []);
    return Loaded ? <Loaded {...props}/> : fallback;
  }
  return Object.assign(Lazy, {preload});
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
  let Loaded: ComponentType | undefined;
  let loading: Promise<void> | undefined;
  const preload = () => {
    if (Loaded) return Promise.resolve();
    loading ??= load().then((m) => {
      Loaded = m[name];
    }, (err: unknown) => {
      loading = undefined;
      throw err;
    });
    return loading;
  };
  function View() {
    if (!Loaded) throw preload();
    return <Loaded/>;
  }
  return Object.assign(View, {preload});
}
