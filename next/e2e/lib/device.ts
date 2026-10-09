// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What this device holds (IndexedDB, the service worker's caches) and its
// connection (context.setOffline).

import {type BrowserContext, expect, type Page} from '@playwright/test';
import {indicator} from './app.ts';

/**
 * Runs a read of the signed-in user's IndexedDB (`forgejo-next:<id>`) in the
 * page: `what` is one of the reads below. Undefined when there is no database.
 */
async function readDb(page: Page, what: {store: string; op: 'count-records' | 'has-key' | 'keys-from'; key: string}): Promise<number | boolean | undefined> {
  return page.evaluate(async ({store, op, key}) => {
    const name = (await indexedDB.databases()).map((d) => d.name ?? '').find((n) => /^forgejo-next:\d+$/.test(n));
    if (!name) return undefined;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => {
        resolve(r.result);
      };
      r.onerror = () => {
        reject(r.error ?? new Error('open'));
      };
    });
    try {
      if (!db.objectStoreNames.contains(store)) return undefined;
      const s = db.transaction(store).objectStore(store);
      const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
        r.onsuccess = () => {
          resolve(r.result);
        };
        r.onerror = () => {
          reject(r.error ?? new Error('read'));
        };
      });
      if (op === 'has-key') return await req(s.getKey(key)) !== undefined;
      if (op === 'keys-from') return (await req(s.getAllKeys(IDBKeyRange.bound(key, `${key}￿`)))).length > 0;
      const values = await req(s.getAll(IDBKeyRange.bound([key], [key, []]))) as {r: unknown[]}[];
      return values.reduce((n, v) => n + v.r.length, 0);
    } finally {
      db.close();
    }
  }, what);
}

/** Whether this device stores a group (its meta is written once its bootstrap finished, not while on screen only). */
export async function storedGroup(page: Page, group: string): Promise<boolean> {
  return await readDb(page, {store: 'meta', op: 'has-key', key: `group:${group}`}) === true;
}

/** How many records of a model IndexedDB holds for a group. */
export async function storedRecords(page: Page, model: string, group: string): Promise<number> {
  return Number(await readDb(page, {store: `m:${model}`, op: 'count-records', key: group}) ?? 0);
}

/** Whether the code cache holds a key (IndexedDB `blobs`, d:<key>…). */
export async function cachedBlob(page: Page, prefix: string): Promise<boolean> {
  return await readDb(page, {store: 'blobs', op: 'keys-from', key: `d:${prefix}`}) === true;
}

/** Waits until the service worker controls the page and has this build cached. */
export async function swReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    return Boolean(reg?.active && navigator.serviceWorker.controller) && keys.some((k) => k.startsWith('forgejo-next-'));
  }), {timeout: 30_000}).toBe(true);
}

export async function goOffline(ctx: BrowserContext, page: Page): Promise<void> {
  await ctx.setOffline(true);
  await expect(indicator(page)).toContainText('Offline', {timeout: 10_000});
}

export async function goOnline(ctx: BrowserContext, page: Page): Promise<void> {
  await ctx.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}
