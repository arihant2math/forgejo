// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The closed tier of a repository (B6): its summary holds open issues and
// everything updated recently; older closed ones load in pages
// (Data.loadClosedPage, newest first) when a list needs them — a search, or a
// filter that shows closed issues — and while the list asks for more.
//
// A page that cannot load (the repository's summary is not loaded yet, the
// group is not held yet, the network) is retried with a backoff; calls in
// between are ignored, so callers may ask as often as they like. Only the
// last page ends it ("done").

import {observable, runInAction} from 'mobx';
import type {Data} from '../../sync/data.ts';

export interface ClosedPager {
  /** Pages loaded and their issues. */
  readonly pages: number;
  readonly count: number;
  /** A page is loading (or waiting to be tried again). */
  readonly loading: boolean;
  /** Every older closed issue is in the pool. */
  readonly done: boolean;
  /** Loads the next page unless one is loading, all are there, or a retry is pending. */
  more(): void;
}

const pagers = new Map<string, ClosedPager>();

/** The longest wait between attempts (ms). */
const MAX_BACKOFF = 30_000;

/** The pager of a repository group (one per group and page load: the pages stay in the pool). */
export function closedPager(data: Data, group: string): ClosedPager {
  let p = pagers.get(group);
  if (p) return p;
  // `wake`: bumped when the connection comes back after a load stopped offline, so observers of `loading`
  // ask again (nothing else they read changes then).
  const state = observable({pages: 0, count: 0, loading: false, done: false, wake: 0}, {}, {deep: false});
  let stoppedOffline = false;
  let next: string | undefined;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const load = () => {
    retry = undefined;
    if (state.done) return;
    if (!navigator.onLine) {
      // Tried again when the connection is back (the `online` listener wakes the callers).
      stoppedOffline = true;
      runInAction(() => {
        state.loading = false;
      });
      return;
    }
    runInAction(() => {
      state.loading = true;
    });
    data.loadClosedPage(group, next).then((r) => {
      next = r.next;
      failures = 0;
      runInAction(() => {
        state.pages++;
        state.count += r.count;
        state.loading = false;
        state.done = r.next === undefined;
      });
    }, () => {
      failures++;
      // Still "loading" while the retry is pending: callers' requests are ignored until then.
      retry = setTimeout(load, Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(failures, 5)));
    });
  };
  p = {
    get pages() {
      return state.pages;
    },
    get count() {
      return state.count;
    },
    get loading() {
      return state.wake >= 0 && state.loading;
    },
    get done() {
      return state.done;
    },
    more() {
      if (state.loading || state.done || retry !== undefined) return;
      load();
    },
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      if (stoppedOffline) {
        stoppedOffline = false;
        runInAction(() => {
          state.wake++;
        });
      }
      if (retry !== undefined) {
        clearTimeout(retry);
        retry = undefined;
        runInAction(() => {
          state.loading = false;
        });
        failures = 0;
      }
    });
  }
  pagers.set(group, p);
  return p;
}
