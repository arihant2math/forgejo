// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Persist unfinished wipes so interrupted sign-outs resume at boot.

import {readJson, writeJson} from '../app/storage.ts';

export const WIPES = 'forgejo-next:wipe';

export function readWipes(): number[] {
  const v = readJson(WIPES);
  return Array.isArray(v) ? v.filter((x): x is number => Number.isSafeInteger(x) && (x as number) > 0) : [];
}

export function writeWipes(ids: number[]): void {
  writeJson(WIPES, ids.length ? ids : undefined);
}

/** Lists a user before anything of the wipe can be interrupted. */
export function listWipe(userId: number): void {
  writeWipes([...new Set([...readWipes(), userId])]);
}

/** Cancels a pending wipe when the user signs in again. */
export function unlistWipe(userId: number): void {
  writeWipes(readWipes().filter((id) => id !== userId));
}
