// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Forgejo stores review state per viewer, pull and head. Carry viewed marks
// forward unless changed; offline, flag uncertain marks as older.

import type {ReviewState} from '../protocol/types.gen.ts';

/** models/pull ViewedState: 2 = viewed. */
const VIEWED = 2;

export interface Viewed {
  paths: Set<string>;
  /** Viewed at another head; changes since then are unknown. */
  older: Set<string>;
  /** The commit of the state used ("" for none). */
  commit: string;
}

export function newestState(states: Iterable<ReviewState>, userId: number): ReviewState | undefined {
  let best: ReviewState | undefined;
  for (const s of states) {
    if (s.user_id !== userId) continue;
    if (!best || s.updated_at > best.updated_at || (s.updated_at === best.updated_at && s.id > best.id)) best = s;
  }
  return best;
}

/** changed is undefined when unknown; overrides apply pending path → viewed intents. */
export function viewedAt(state: ReviewState | undefined, head: string, changed: ReadonlySet<string> | undefined, overrides?: ReadonlyMap<unknown, boolean>): Viewed {
  const paths = new Set<string>();
  const older = new Set<string>();
  if (state) {
    const same = state.commit_sha === head;
    for (const [p, v] of Object.entries(state.updated_files)) {
      if (v !== VIEWED) continue;
      if (same) paths.add(p);
      else if (!changed?.has(p)) {
        paths.add(p);
        if (!changed) older.add(p);
      }
    }
  }
  for (const [p, v] of overrides ?? []) {
    if (typeof p !== 'string') continue;
    older.delete(p);
    if (v) paths.add(p);
    else paths.delete(p);
  }
  return {paths, older, commit: state?.commit_sha ?? ''};
}

/**
 * Forgejo seeds new-head state from the previous head, so reset changed files.
 * Preserve pending marks to avoid undoing an earlier toggle before sync catches up.
 */
export function viewedMarks(viewed: Pick<Viewed, 'commit'> & {changed?: ReadonlySet<string> | undefined}, head: string, path: string, on: boolean, pending?: ReadonlyMap<unknown, boolean>): Record<string, boolean> {
  const marks: Record<string, boolean> = {};
  if (viewed.commit && viewed.commit !== head) for (const p of viewed.changed ?? []) if (!pending?.has(p)) marks[p] = false;
  marks[path] = on;
  return marks;
}
