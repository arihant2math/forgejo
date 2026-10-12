// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {readJson, writeJson} from './storage.ts';

const KEY = 'forgejo-next:board';

export function rememberBoard(userId: number, projectId: number): void {
  writeJson(KEY, {user: userId, project: projectId});
}

/** The last board's project id, or undefined (none, another user's, storage blocked). */
export function lastBoard(userId: number): number | undefined {
  const v = readJson(KEY) as {user?: unknown; project?: unknown} | null | undefined;
  return v?.user === userId && typeof v.project === 'number' && Number.isSafeInteger(v.project) && v.project > 0 ? v.project : undefined;
}
