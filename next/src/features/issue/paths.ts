// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/** The path segment of an issue created offline (see `tempIssuePath`). */
export const TEMP_PATH = /^new-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/;

/** The page of an issue created offline, before Forgejo numbers it ("…/issues/new-<tempId>"). */
export function tempIssuePath(owner: string, repo: string, tempId: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/new-${tempId}`;
}
