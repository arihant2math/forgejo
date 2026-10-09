// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Viewed files of a pull request (B9; synced as ReviewState in the viewer's
// group): Forgejo keeps one state per (viewer, pull request, head commit).
// The newest one counts. Saved for the head on screen, its viewed files are
// viewed; saved for an older head, a file viewed then is viewed now unless it
// changed since (B9's `?head=` answer names those) — offline without that
// answer it stays viewed (marked as from an older commit). Pending
// `pr.viewed` intents go on top (the overlay). Pure.

import type {ReviewState} from '../protocol/types.gen.ts';

/** models/pull ViewedState: 2 = viewed. */
const VIEWED = 2;

export interface Viewed {
  /** Paths shown as viewed. */
  paths: Set<string>;
  /** The state was saved for another head: these paths were viewed then (and may have changed). */
  older: Set<string>;
  /** The commit of the state used ("" for none). */
  commit: string;
}

/** The newest state among a viewer's states of a pull request. */
export function newestState(states: Iterable<ReviewState>, userId: number): ReviewState | undefined {
  let best: ReviewState | undefined;
  for (const s of states) {
    if (s.user_id !== userId) continue;
    if (!best || s.updated_at > best.updated_at || (s.updated_at === best.updated_at && s.id > best.id)) best = s;
  }
  return best;
}

/**
 * The viewed paths at `head`. `changed`: the paths B9 reports has_changed
 * between the state's commit and head (undefined: not known).
 * `overrides`: pending intents, path → viewed.
 */
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
 * What one "viewed" toggle sends at `head`. The first mark at a new head also
 * sends the files changed since the state's commit as not viewed (Forgejo
 * seeds the head's state from the previous one; the classic files view stores
 * that when it renders) — once per path: a path with a pending mark keeps it,
 * so a second file marked before the server's state for this head is back
 * does not un-view the first.
 */
export function viewedMarks(viewed: Pick<Viewed, 'commit'> & {changed?: ReadonlySet<string> | undefined}, head: string, path: string, on: boolean, pending?: ReadonlyMap<unknown, boolean>): Record<string, boolean> {
  const marks: Record<string, boolean> = {};
  if (viewed.commit && viewed.commit !== head) for (const p of viewed.changed ?? []) if (!pending?.has(p)) marks[p] = false;
  marks[path] = on;
  return marks;
}
