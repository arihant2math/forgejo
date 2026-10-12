// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Forgejo has no client token-revocation endpoint; sign-out only forgets local tokens.
// Other tabs must close IndexedDB before deletion; blocked wipes resume at boot.

import {forgetUser, LOCAL_PREFS} from '../app/splash.ts';
import {deleteDatabase} from '../data/idb.ts';
import {pendingIntentCount} from '../sync/data.ts';
import type {AuthSession} from './session.ts';
import {deleteToken} from './tokens.ts';
import {listWipe, readWipes, unlistWipe} from './wipes.ts';

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
  for (const key of LOCAL_PREFS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage blocked.
    }
  }
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
