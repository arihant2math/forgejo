// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Keep tokens separate from user data so an expired session preserves unsynced intents.

import {done, request} from '../data/idb.ts';

export const AUTH_DB = 'forgejo-next-auth';
const VERSION = 1;
const TOKENS = 'tokens';

export interface TokenRecord {
  userId: number;
  login: string;
  refreshToken: string;
  /** When the refresh token was stored (ms). */
  updated: number;
  /** The access token issued with it and when it expires (ms), for the next document. */
  accessToken?: string;
  expiresAt?: number;
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(AUTH_DB, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(TOKENS)) req.result.createObjectStore(TOKENS, {keyPath: 'userId'});
    };
    req.onsuccess = () => {
      const db = req.result;
      // Never block another tab's upgrade or delete.
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('indexedDB.open failed'));
    };
  });
}

/** Short-lived connections: refreshes are rare, and a held connection would block a delete. */
async function withStore<T>(factory: IDBFactory, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open(factory);
  try {
    const tx = db.transaction(TOKENS, mode);
    const result = request(fn(tx.objectStore(TOKENS)));
    await done(tx);
    return await result;
  } finally {
    db.close();
  }
}

export function readToken(userId: number, factory: IDBFactory = indexedDB): Promise<TokenRecord | undefined> {
  return withStore(factory, 'readonly', (s) => s.get(userId) as IDBRequest<TokenRecord | undefined>);
}

export async function writeToken(rec: TokenRecord, factory: IDBFactory = indexedDB): Promise<void> {
  await withStore(factory, 'readwrite', (s) => s.put(rec));
}

export async function deleteToken(userId: number, factory: IDBFactory = indexedDB): Promise<void> {
  await withStore(factory, 'readwrite', (s) => s.delete(userId));
}
