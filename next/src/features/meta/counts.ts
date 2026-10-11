// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Counts of a repository's labels and milestones, computed from the issues
// on this device (pure; repoCounts.ts feeds it from the pool and the
// overlay), so the pages paint at once, offline too, and follow a local
// change in the same frame.
//
// Open issues are all on the device (the summary tier holds every open one,
// B6); older closed ones load in pages. So open counts are exact here, and a
// milestone's closed count leans on the server's (Milestone.closed_issues,
// live with the sync) where this device holds fewer.

import type {Milestone} from '../../protocol/types.gen.ts';

/** What the counts need to know of an issue, as the user sees it (pending changes included). */
export interface IssueFacts {
  state: string;
  isPull: boolean;
  /** 0: no milestone. */
  milestone: number;
  labels: readonly number[];
}

/** A label's open issues and open pull requests. */
export interface LabelCount {
  issues: number;
  pulls: number;
}

/** A milestone's open and closed issues and pull requests (Forgejo counts both). */
export interface MilestoneCount {
  open: number;
  closed: number;
}

export interface RepoCounts {
  labels: ReadonlyMap<number, LabelCount>;
  milestones: ReadonlyMap<number, MilestoneCount>;
}

/** One pass over a repository's issues. */
export function countIssues(issues: Iterable<IssueFacts>): RepoCounts {
  const labels = new Map<number, LabelCount>();
  const milestones = new Map<number, MilestoneCount>();
  for (const i of issues) {
    const open = i.state !== 'closed';
    if (open) {
      for (const id of i.labels) {
        let c = labels.get(id);
        if (!c) labels.set(id, c = {issues: 0, pulls: 0});
        if (i.isPull) c.pulls++;
        else c.issues++;
      }
    }
    if (i.milestone > 0) {
      let m = milestones.get(i.milestone);
      if (!m) milestones.set(i.milestone, m = {open: 0, closed: 0});
      if (open) m.open++;
      else m.closed++;
    }
  }
  return {labels, milestones};
}

/** A milestone's progress: its open and closed items, their total, and the share closed (0–100, whole). */
export interface Progress {
  open: number;
  closed: number;
  total: number;
  percent: number;
}

/**
 * A milestone's progress. Open: what this device holds (every open issue is here). Closed: the server's total less
 * what is open here — so an issue closed here (not synced yet) moves from open to closed at once — but never fewer
 * than the closed ones held here (the server's count may lag a delta). With none of its issues here (the
 * repository's issues not loaded yet), the server's counts.
 */
export function milestoneProgress(server: Pick<Milestone, 'open_issues' | 'closed_issues'>, local: MilestoneCount | undefined): Progress {
  const open = local ? local.open : Math.max(server.open_issues, 0);
  const closed = local ? Math.max(local.closed, server.open_issues + server.closed_issues - open, 0) : Math.max(server.closed_issues, 0);
  const total = open + closed;
  return {open, closed, total, percent: total > 0 ? Math.floor((closed / total) * 100) : 0};
}
