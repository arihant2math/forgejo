// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The closed tier of a repository (B6): its summary holds open issues and
// everything updated recently; older closed ones load in pages
// (Data.loadClosedPage, newest first) when a list needs them — a search, or a
// filter that shows closed issues — and as the user scrolls to the end.

import {observable, runInAction} from 'mobx';
import type {Data} from '../../sync/data.ts';

export interface ClosedPager {
  /** Pages loaded and their issues. */
  readonly pages: number;
  readonly count: number;
  /** A page is loading. */
  readonly loading: boolean;
  /** Every older closed issue is in the pool (or the tier cannot be loaded here). */
  readonly done: boolean;
  /** Loads the next page unless one is loading or all are there. */
  more(): void;
}

const pagers = new Map<string, ClosedPager>();

/** The pager of a repository group (one per group and page load: the pages stay in the pool). */
export function closedPager(data: Data, group: string): ClosedPager {
  let p = pagers.get(group);
  if (p) return p;
  const state = observable({pages: 0, count: 0, loading: false, done: false}, {}, {deep: false});
  let next: string | undefined;
  let failures = 0;
  p = {
    get pages() {
      return state.pages;
    },
    get count() {
      return state.count;
    },
    get loading() {
      return state.loading;
    },
    get done() {
      return state.done;
    },
    more() {
      if (state.loading || state.done || !navigator.onLine) return;
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
        // The summary is not loaded yet (no cutoff to start from), or the network failed: try again a little later.
        failures++;
        runInAction(() => {
          state.loading = false;
          state.done = failures >= 10;
        });
        if (!state.done) setTimeout(() => {
          p?.more();
        }, 2000);
      });
    },
  };
  pagers.set(group, p);
  return p;
}
