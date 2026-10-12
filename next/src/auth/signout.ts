// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Forgejo has no client token-revocation endpoint; sign-out only forgets local tokens.
// Other tabs must close IndexedDB before deletion; blocked wipes resume at boot.

import {forgetUser} from '../app/splash.ts';
import {STORAGE_PREFIX} from '../app/storage.ts';
import {deleteDatabase} from '../data/idb.ts';
import {pendingIntentCount} from '../sync/data.ts';
import type {AuthSession} from './session.ts';
import {deleteToken} from './tokens.ts';
import {WEB_LOGOUT} from './weblogout.ts';
import {listWipe, readWipes, unlistWipe, WIPES} from './wipes.ts';

const WIPE_TIMEOUT = 5000;

/** Deletes a user's refresh token and database; listed until done, so an interrupted wipe resumes at the next boot. */
export async function wipeUser(userId: number, factory?: IDBFactory): Promise<boolean> {
  listWipe(userId);
  const work = (async () => {
    await deleteToken(userId, factory);
    await deleteDatabase(userId, factory);
    return true;
  })();
  const ok = await Promise.race([
    work,
    new Promise<false>((resolve) => setTimeout(() => {
      resolve(false);
    }, WIPE_TIMEOUT)),
  ]).catch((err: unknown) => {
    console.error('sign-out: wiping local data failed', err);
    return false;
  });
  if (ok) unlistWipe(userId);
  return ok;
}

/** Finishes wipes an earlier sign-out could not (never the current user's). */
export function resumeWipes(currentUser: number | undefined): void {
  for (const id of readWipes()) {
    if (id !== currentUser) void wipeUser(id);
  }
}

/** Preserves unsynced intents for the previous user’s next sign-in; otherwise wipes their data. */
export async function dropPreviousUser(userId: number, factory?: IDBFactory): Promise<void> {
  if (await pendingIntentCount(userId, factory) === 0) await wipeUser(userId, factory);
}

/**
 * Keys that outlive a sign-out: they finish it (and other users' wipes) at the next boot.
 * The browser-wide RUM report budget (app/rum.ts) is swept too; the server's own limit bounds a reset.
 */
const OUTLIVE = new Set([WIPES, WEB_LOGOUT]);

/** Removes every app key but OUTLIVE, so per-user state (preferences, cached notification subjects) cannot be missed. */
export function forgetLocalStorage(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX) && !OUTLIVE.has(k)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // Storage blocked.
  }
}

export interface SignOutParts {
  auth: AuthSession;
  /** Stops this tab’s data-layer writes before the database is wiped. */
  close: () => Promise<void>;
  /** Ends Forgejo's own (classic) web session too, or the next person on the device signs back in with one click. */
  endWebSession?: () => Promise<void>;
  factory?: IDBFactory;
}

/** Signs out on this device and tells the other tabs. The caller then shows the logged-out screen (reload). */
export async function signOut({auth, close, endWebSession, factory}: SignOutParts): Promise<void> {
  const {userId} = auth;
  // Clear the boot marker and list the wipe before interruptible work.
  forgetUser();
  forgetLocalStorage();
  listWipe(userId);
  auth.post({t: 'logout', userId});
  // The refresh token goes under the refresh lock: no refresh in flight writes one back.
  await auth.forget().catch((err: unknown) => {
    console.error('sign-out: deleting the refresh token failed', err);
  });
  await close().catch((err: unknown) => {
    console.error('sign-out: closing the data layer failed', err);
  });
  await wipeUser(userId, factory);
  await endWebSession?.().catch((err: unknown) => {
    console.error('sign-out: ending the web session failed', err);
  });
}
