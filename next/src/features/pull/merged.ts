// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// API v1 returns an empty 405 for an already-merged pull request; treat concurrent merges as success.

import {online, RequestFailed} from '../../app/api.ts';
import type {App} from '../../app/store.ts';

/** undefined means not merged or unknown; otherwise returns the merger when known. */
export async function mergedMeanwhile(app: App, err: unknown, path: string, merged: () => boolean): Promise<{by: string | undefined} | undefined> {
  if (!(err instanceof RequestFailed) || (err.status !== 405 && err.status !== 409)) return undefined;
  if (merged()) return {by: undefined};
  try {
    const pr = await online<{merged?: boolean; merged_by?: {login?: string} | null}>(app, {api: 'v1', path});
    const by = pr?.merged_by?.login;
    return pr?.merged === true ? {by: by === '' ? undefined : by} : undefined;
  } catch {
    return undefined;
  }
}
