// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The IndexedDB schema (PLAN §5.3): one database per (origin, user) —
// IndexedDB is per origin already, the name carries the user id. One object
// store per model ("m:<Model>", records `{id, g, v, d}` = EntityRecord),
// indexed on the group and on the model's hot fields; plus `meta` (group
// positions, units, schemas, workspace, the flush sequence), `intents` (the
// offline queue, F5), `drafts` and `blobs` (the SHA cache, F7).
//
// Upgrades reconcile the stores with this file's layout: a model store whose
// indexes changed is dropped and created again (its model is re-bootstrapped:
// the names land in meta "droppedModels"), unknown model stores are deleted,
// and `intents` / `drafts` are never dropped (their indexes may be added or
// removed, the records stay). Bump IDB_VERSION whenever the layout changes.

import {MODEL_NAMES, MODELS, type ModelName} from './models.ts';

export const IDB_VERSION = 1;

export const META = 'meta';
export const INTENTS = 'intents';
export const DRAFTS = 'drafts';
export const BLOBS = 'blobs';

const MODEL_PREFIX = 'm:';

export function modelStore(m: ModelName): string {
  return MODEL_PREFIX + m;
}

export function dbName(userId: number): string {
  return `forgejo-next:${userId}`;
}

export interface StoreLayout {
  keyPath: string;
  autoIncrement?: boolean;
  /** Index name → key path. */
  indexes: Record<string, string>;
}

export type Layout = Record<string, StoreLayout>;

/** The layout of this build. */
export function layout(): Layout {
  const out: Layout = {
    [META]: {keyPath: 'k', indexes: {}},
    // F5 defines the intent records; keyed by a client sequence, looked up by entity.
    [INTENTS]: {keyPath: 'seq', autoIncrement: true, indexes: {}},
    [DRAFTS]: {keyPath: 'key', indexes: {}},
    [BLOBS]: {keyPath: 'sha', indexes: {atime: 'atime'}},
  };
  for (const m of MODEL_NAMES) {
    const def: {idbIndex?: readonly string[]} = MODELS[m];
    const indexes: Record<string, string> = {g: 'g'};
    for (const f of def.idbIndex ?? []) indexes[f] = `d.${f}`;
    out[modelStore(m)] = {keyPath: 'id', indexes};
  }
  return out;
}

/** Stores that keep their records across every upgrade. */
const PRESERVED = new Set([INTENTS, DRAFTS, BLOBS, META]);

function sameIndexes(store: IDBObjectStore, want: Record<string, string>): boolean {
  const names = [...store.indexNames];
  if (names.length !== Object.keys(want).length) return false;
  return names.every((n) => Object.hasOwn(want, n) && store.index(n).keyPath === want[n]);
}

function createStore(db: IDBDatabase, name: string, l: StoreLayout): IDBObjectStore {
  const opts: IDBObjectStoreParameters = {keyPath: l.keyPath};
  if (l.autoIncrement) opts.autoIncrement = true;
  const store = db.createObjectStore(name, opts);
  for (const [n, kp] of Object.entries(l.indexes)) store.createIndex(n, kp);
  return store;
}

/** Brings the database to `want` inside a versionchange transaction; returns the dropped models. */
export function reconcile(db: IDBDatabase, tx: IDBTransaction, want: Layout): string[] {
  const dropped: string[] = [];
  for (const name of [...db.objectStoreNames]) {
    if (Object.hasOwn(want, name)) continue;
    if (PRESERVED.has(name)) continue; // never delete user data, even if a later layout forgets a store
    db.deleteObjectStore(name);
  }
  for (const [name, l] of Object.entries(want)) {
    if (!db.objectStoreNames.contains(name)) {
      createStore(db, name, l);
      continue;
    }
    const store = tx.objectStore(name);
    if (store.keyPath === l.keyPath && store.autoIncrement === Boolean(l.autoIncrement) && sameIndexes(store, l.indexes)) continue;
    if (PRESERVED.has(name) && store.keyPath === l.keyPath && store.autoIncrement === Boolean(l.autoIncrement)) {
      // Keep the records, fix the indexes.
      for (const n of [...store.indexNames]) if (store.index(n).keyPath !== l.indexes[n]) store.deleteIndex(n);
      for (const [n, kp] of Object.entries(l.indexes)) if (!store.indexNames.contains(n)) store.createIndex(n, kp);
      continue;
    }
    if (PRESERVED.has(name)) throw new Error(`refusing to drop ${name}: its key changed`);
    db.deleteObjectStore(name);
    createStore(db, name, l);
    if (name.startsWith(MODEL_PREFIX)) dropped.push(name.slice(MODEL_PREFIX.length));
  }
  if (dropped.length) {
    // Recorded in the same transaction: the next start re-bootstraps them even if this one dies first.
    const meta = tx.objectStore(META);
    const req = meta.get('droppedModels');
    req.onsuccess = () => {
      const prev = (req.result as {v?: string[]} | undefined)?.v ?? [];
      meta.put({k: 'droppedModels', v: [...new Set([...prev, ...dropped])]});
    };
  }
  return dropped;
}

export interface OpenOptions {
  factory?: IDBFactory;
  /** For tests: another layout / version. */
  layout?: Layout;
  version?: number;
  /** Another tab wants to upgrade or delete the database: close and reload. */
  onVersionChange?: () => void;
}

export function openDatabase(userId: number, opts: OpenOptions = {}): Promise<IDBDatabase> {
  const factory = opts.factory ?? indexedDB;
  const want = opts.layout ?? layout();
  return new Promise((resolve, reject) => {
    const req = factory.open(dbName(userId), opts.version ?? IDB_VERSION);
    req.onupgradeneeded = () => {
      const tx = req.transaction;
      if (tx) reconcile(req.result, tx, want);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        opts.onVersionChange?.();
      };
      resolve(db);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('indexedDB.open failed'));
    };
    req.onblocked = () => {
      // Another tab holds an older version open; its onversionchange closes it.
    };
  });
}

export function deleteDatabase(userId: number, factory: IDBFactory = indexedDB): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = factory.deleteDatabase(dbName(userId));
    req.onsuccess = () => {
      resolve();
    };
    req.onerror = () => {
      reject(req.error ?? new Error('indexedDB.deleteDatabase failed'));
    };
  });
}

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

/** A readwrite transaction; relaxed durability where supported (Chromium: no fsync per commit). */
export function writeTx(db: IDBDatabase, stores: string[]): IDBTransaction {
  return db.transaction(stores, 'readwrite', {durability: 'relaxed'});
}

/** Reads every meta record. */
export async function readMeta(db: IDBDatabase): Promise<Map<string, unknown>> {
  const tx = db.transaction(META, 'readonly');
  const rows = await request(tx.objectStore(META).getAll() as IDBRequest<{k: string; v: unknown}[]>);
  return new Map(rows.map((r) => [r.k, r.v]));
}
