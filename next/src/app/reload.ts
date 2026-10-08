// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A chunk of an older build (deleted after a deploy) or a network error:
// reload once to get the current index.html (served with Cache-Control:
// no-cache); a second failure shows a Reload screen instead of looping.
// F5's service worker makes this rare.

const KEY = 'bootRetry';

/** Whether an error is a failed dynamic import (a route chunk). */
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

/** The app booted: a later failure may reload once again. */
export function bootSucceeded(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked.
  }
}
