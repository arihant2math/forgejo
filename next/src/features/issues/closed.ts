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

interface Entry {
  pager: ClosedPager;
  /** Called when the browser comes back online. */
  wake: () => void;
  /** The group was revoked: no more retries. */
  stop: () => void;
}

const pagers = new WeakMap<Data, Map<string, Entry>>();
const live = new Set<Entry>();

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    for (const p of live) p.wake();
  });
}

/** Maximum retry delay in milliseconds. */
const MAX_BACKOFF = 30_000;

/** One pager per repository group, dropped when the group is revoked; loaded pages remain in the pool. */
export function closedPager(data: Data, group: string): ClosedPager {
  let mine = pagers.get(data);
  if (!mine) {
    const all = new Map<string, Entry>();
    pagers.set(data, mine = all);
    data.on('revoked', ({group: g}) => {
      const e = all.get(g);
      if (!e) return;
      e.stop();
      live.delete(e);
      all.delete(g);
    });
  }
  const known = mine.get(group);
  if (known) return known.pager;
  // Wake loading observers on reconnect even when no other observed field changes.
  const state = observable({pages: 0, count: 0, loading: false, done: false, wake: 0}, {}, {deep: false});
  let stoppedOffline = false;
  let stopped = false;
  let next: string | undefined;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const load = () => {
    retry = undefined;
    if (stopped || state.done) return;
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
      if (stopped) return;
      next = r.next;
      failures = 0;
      runInAction(() => {
        state.pages++;
        state.count += r.count;
        state.loading = false;
        state.done = r.next === undefined;
      });
    }, () => {
      if (stopped) return;
      failures++;
      // Treat retry waits as loading to suppress duplicate requests.
      retry = setTimeout(load, Math.min(MAX_BACKOFF, 1000 * 2 ** Math.min(failures, 5)));
    });
  };
  const pager: ClosedPager = {
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
  const wake = () => {
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
  };
  const stop = () => {
    stopped = true;
    clearTimeout(retry);
    retry = undefined;
    runInAction(() => {
      state.done = true;
      state.loading = false;
    });
  };
  const entry = {pager, wake, stop};
  mine.set(group, entry);
  live.add(entry);
  return pager;
}
