// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Signing out (PLAN §4.9): forget the tokens, wipe the user's data on this
// device, and tell every tab. The UI warns first when intents have not
// synced (they are deleted with the database).
//
// Forgejo has no token revocation endpoint for the client (B8 notes): the
// grant stays listed in the user's settings (Applications) until revoked
// there. Signing out forgets the access token (memory) and deletes the
// refresh token (IndexedDB).
//
// A database cannot be deleted while another tab holds it open: those tabs
// close it on the `logout` broadcast (and on IndexedDB's versionchange). A
// wipe that does not finish in time stays listed in localStorage and is
// finished at the next boot (resumeWipes).

import {forgetUser} from '../app/splash.ts';
import {deleteDatabase} from '../data/idb.ts';
import {pendingIntentCount} from '../sync/data.ts';
import type {AuthSession} from './session.ts';
import {deleteToken} from './tokens.ts';

const WIPES = 'forgejo-next:wipe';
const WIPE_TIMEOUT = 5000;

function readWipes(): number[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(WIPES) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is number => Number.isSafeInteger(x) && (x as number) > 0) : [];
  } catch {
    return [];
  }
}

function writeWipes(ids: number[]): void {
  try {
    if (ids.length) localStorage.setItem(WIPES, JSON.stringify(ids));
    else localStorage.removeItem(WIPES);
  } catch {
    // Storage blocked.
  }
}

/** Deletes a user's refresh token and database; listed until done, so an interrupted wipe resumes at the next boot. */
export async function wipeUser(userId: number, factory?: IDBFactory): Promise<boolean> {
  writeWipes([...new Set([...readWipes(), userId])]);
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
  if (ok) writeWipes(readWipes().filter((id) => id !== userId));
  return ok;
}

/** Finishes wipes an earlier sign-out could not (never the current user's). */
export function resumeWipes(currentUser: number | undefined): void {
  for (const id of readWipes()) {
    if (id !== currentUser) void wipeUser(id);
  }
}

/**
 * Another user signed in on this device: the previous user's data is deleted
 * unless it holds unsynced intents (then it is kept for that user's next
 * sign-in, PLAN §4.9).
 */
export async function dropPreviousUser(userId: number, factory?: IDBFactory): Promise<void> {
  if (await pendingIntentCount(userId, factory) === 0) await wipeUser(userId, factory);
}

export interface SignOutParts {
  auth: AuthSession;
  /** Closes the data layer (this tab stops writing the database). */
  close: () => Promise<void>;
  factory?: IDBFactory;
}

/** Signs out on this device and tells the other tabs. The caller then shows the logged-out screen (reload). */
export async function signOut({auth, close, factory}: SignOutParts): Promise<void> {
  const {userId} = auth;
  // First: a tab that boots from now on shows the logged-out screen.
  forgetUser();
  auth.post({t: 'logout', userId});
  auth.close();
  await close().catch((err: unknown) => {
    console.error('sign-out: closing the data layer failed', err);
  });
  await wipeUser(userId, factory);
}
