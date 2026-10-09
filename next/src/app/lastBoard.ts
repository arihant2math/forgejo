// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The board G B goes back to (the last one opened by this user on this
// device). Cleared at sign-out with the other LOCAL_PREFS.

import {LOCAL_PREFS} from './splash.ts';

const KEY = LOCAL_PREFS[1];

export function rememberBoard(userId: number, projectId: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({user: userId, project: projectId}));
  } catch {
    // Storage blocked.
  }
}

/** The last board's project id, or undefined (none, another user's, storage blocked). */
export function lastBoard(userId: number): number | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as {user?: unknown; project?: unknown} | null;
    return v?.user === userId && typeof v.project === 'number' && Number.isSafeInteger(v.project) && v.project > 0 ? v.project : undefined;
  } catch {
    return undefined;
  }
}
