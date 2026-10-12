// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// localStorage values the app keeps; storage may be blocked, full, or hold anything another build wrote.

/** Every app key starts with this; sign-out removes them all but a few (auth/signout.ts). */
export const STORAGE_PREFIX = 'forgejo-next:';

/** The parsed value, or undefined when missing, corrupt or blocked. Validate before use. */
export function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Stores a value (undefined removes it); a blocked or full storage keeps this page's state only. */
export function writeJson(key: string, v: unknown): void {
  try {
    if (v === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Storage blocked or full.
  }
}
