// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A deploy can delete route chunks; reload once for a fresh index.html, then show an error to avoid loops.

const KEY = 'bootRetry';

export function isChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg);
}

/** Reloads unless this tab already did for a failed boot; returns whether it reloads. */
export function reloadOnce(): boolean {
  let retried = true;
  try {
    retried = sessionStorage.getItem(KEY) !== null;
    if (!retried) sessionStorage.setItem(KEY, '1');
  } catch {
    // Storage blocked: do not risk a reload loop.
  }
  if (!retried) location.reload();
  return !retried;
}

export function bootSucceeded(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked.
  }
}
