// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Older closed issues are paged newest-first, outside the repository summary.
// Failed pages retry with backoff; only the final page marks the pager done.

import {observable, runInAction} from 'mobx';
import type {Data} from '../../sync/data.ts';

export interface ClosedPager {
  readonly pages: number;
  readonly count: number;
  /** Includes retry waits. */
  readonly loading: boolean;
  readonly done: boolean;
  /** Ignores requests while loading, done, or waiting to retry. */
  more(): void;
}

const pagers = new Map<string, ClosedPager>();

/** Maximum retry delay in milliseconds. */
const MAX_BACKOFF = 30_000;

/** One pager per repository group; loaded pages remain in the pool. */
export function closedPager(data: Data, group: string): ClosedPager {
  let p = pagers.get(group);
  if (p) return p;
  // Wake loading observers on reconnect even when no other observed field changes.
  const state = observable({pages: 0, count: 0, loading: false, done: false, wake: 0}, {}, {deep: false});
  let stoppedOffline = false;
  let next: string | undefined;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const load = () => {
    retry = undefined;
    if (state.done) return;
    if (!navigator.onLine) {
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
      // Treat retry waits as loading to suppress duplicate requests.
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
