// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// RUM marks of the data layer (PLAN §5.8): `wsOpen` (the first sync
// transport opened), `caughtUp` (the first caught_up), and the hydration
// measures `hydrate:route` / `hydrate:all` (data.ts). `appStart` is the
// boot script's (F1), `firstPaintFromCache` the shell's (F3). F8 posts them
// to /-/sync/rum.

const marked = new Set<string>();

/** Marks `name` the first time it happens in this page. */
export function markOnce(name: string): void {
  if (marked.has(name)) return;
  marked.add(name);
  try {
    performance.mark(name);
  } catch {
    // No User Timing (tests).
  }
}

/** A measure from `start` (a mark name or a timestamp) to now. */
export function measure(name: string, start: number): void {
  try {
    performance.measure(name, {start, end: performance.now()});
  } catch {
    // No User Timing.
  }
}
