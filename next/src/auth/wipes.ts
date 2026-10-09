// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The users whose local data a sign-out started to wipe (localStorage), so an
// interrupted wipe finishes at the next boot (signout.ts resumeWipes).

const WIPES = 'forgejo-next:wipe';

export function readWipes(): number[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(WIPES) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is number => Number.isSafeInteger(x) && (x as number) > 0) : [];
  } catch {
    return [];
  }
}

export function writeWipes(ids: number[]): void {
  try {
    if (ids.length) localStorage.setItem(WIPES, JSON.stringify(ids));
    else localStorage.removeItem(WIPES);
  } catch {
    // Storage blocked.
  }
}

/** Lists a user before anything of the wipe can be interrupted. */
export function listWipe(userId: number): void {
  writeWipes([...new Set([...readWipes(), userId])]);
}

/** The user signed in again: their data is theirs again, never wiped by an old listing. */
export function unlistWipe(userId: number): void {
  writeWipes(readWipes().filter((id) => id !== userId));
}
