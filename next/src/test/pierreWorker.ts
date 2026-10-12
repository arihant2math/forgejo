// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A stand-in for @pierre/diffs/worker in jsdom, which has no Worker: a pool that always works and highlights nothing.

export const primed: {name: string; cacheKey?: string | undefined}[] = [];

const pool = {
  isWorkingPool: () => true,
  subscribeToStatChanges: () => () => undefined,
  primeFileHighlightCache: (file: {name: string; cacheKey?: string}) => {primed.push(file); return Promise.resolve();},
};

export function getOrCreateWorkerPoolSingleton() {
  return pool;
}
