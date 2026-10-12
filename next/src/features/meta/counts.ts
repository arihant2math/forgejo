// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// All open issues are held locally, but closed issues are paged.
// Use server milestone totals when older closed issues are missing.

import type {Milestone} from '../../protocol/types.gen.ts';

export interface IssueFacts {
  state: string;
  isPull: boolean;
  /** 0: no milestone. */
  milestone: number;
  labels: readonly number[];
}

export interface LabelCount {
  issues: number;
  pulls: number;
}

export interface MilestoneCount {
  open: number;
  closed: number;
}

export interface RepoCounts {
  labels: ReadonlyMap<number, LabelCount>;
  milestones: ReadonlyMap<number, MilestoneCount>;
}

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

/** percent is the whole-number closed share (0–100). */
export interface Progress {
  open: number;
  closed: number;
  total: number;
  percent: number;
}

/**
 * Use local open counts and the server total to reflect pending closures.
 * Closed counts never fall below local counts; without local issues use server counts.
 */
export function milestoneProgress(server: Pick<Milestone, 'open_issues' | 'closed_issues'>, local: MilestoneCount | undefined): Progress {
  const open = local ? local.open : Math.max(server.open_issues, 0);
  const closed = local ? Math.max(local.closed, server.open_issues + server.closed_issues - open, 0) : Math.max(server.closed_issues, 0);
  const total = open + closed;
  return {open, closed, total, percent: total > 0 ? Math.floor((closed / total) * 100) : 0};
}
