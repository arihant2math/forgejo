// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A merge Forgejo refused because the pull request is merged already (someone
// else merged it first: API v1 answers 405 without a message). Not a failure
// for the person merging: the work is in.

import {online, RequestFailed} from '../../app/api.ts';
import type {App} from '../../app/store.ts';

/**
 * Whether a refused merge found the pull request merged: known merged here (`merged`), else asked of API v1 (`path`,
 * the pull request's). undefined when it is not merged (or that cannot be told); else who merged it, when known.
 */
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
