// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The shell owns revocation without loading the cache module. Once cache.ts is loaded it registers its purge here,
// so a revoked repository is marked and dropped from memory before any answer still in flight can be kept.

type Purge = (db: IDBDatabase, group: string) => Promise<void>;

let loaded: Purge | undefined;

export function registerPurge(purge: Purge): void {
  loaded = purge;
}

/** Purges a revoked group's cached content: synchronously up to IndexedDB when the cache is loaded, else after loading it. */
export function purgeCached(db: IDBDatabase, group: string): Promise<void> {
  if (loaded) return loaded(db, group);
  return import('./cache.ts').then((m) => m.purgeRevoked(db, group));
}
