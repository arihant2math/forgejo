// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ComponentType, type ReactNode, useEffect, useReducer} from 'react';

export interface LazyComponent<P extends object> {
  (props: P): ReactNode;
  /** Starts loading the chunk (on idle, on intent). */
  preload(): Promise<void>;
}

/**
 * A component in its own chunk, without Suspense: it renders nothing until
 * the chunk is there (React holds a Suspense reveal for up to 300 ms, which
 * an overlay opened from the keyboard must not wait for). Preload it when
 * the app is idle so that it usually renders on the first try.
 */
export function lazyComponent<P extends object>(load: () => Promise<ComponentType<P>>): LazyComponent<P> {
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
      if (!Loaded) {
        preload().then(rerender, (err: unknown) => {
          console.error('loading a chunk failed', err);
        });
      }
    }, []);
    return Loaded ? <Loaded {...props}/> : null;
  }
  return Object.assign(Lazy, {preload});
}

/** Runs `fn` when the browser is idle (soon after first paint). */
export function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, {timeout: 2000});
  else setTimeout(fn, 200);
}

/**
 * A route view in its own chunk. The router preloads it before it renders
 * the route (so it never suspends in practice); a chunk that fails to load
 * rejects the preload, which puts the route in the error state (RouteError
 * reloads once) — at boot too, where main.tsx reloads or shows BootFailed.
 */
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
    // Not preloaded (should not happen): suspend until it is.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- React's Suspense protocol
    if (!Loaded) throw preload();
    return <Loaded/>;
  }
  return Object.assign(View, {preload});
}
