// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A pull request's checks at a commit, from the pool: the latest commit
// status per context and the workflow runs of the commit, without counting a
// job twice (Forgejo Actions reports each job as a commit status too, linking
// to the run), and their sum (the merge box says it).

import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import type {PullRequest} from '../../protocol/types.gen.ts';

export type ChecksSummary = 'none' | 'pending' | 'failure' | 'success';

export interface Checks {
  statuses: Entity<'CommitStatus'>[];
  runs: Entity<'ActionRun'>[];
  summary: ChecksSummary;
}

const PENDING = new Set(['pending', 'waiting', 'running', 'blocked']);
const FAILED = new Set(['failure', 'error', 'cancelled']);

export function checksOf(pool: Pool, pr: PullRequest, head: string): Checks {
  const latest = new Map<string, Entity<'CommitStatus'>>();
  for (const s of pool.model('CommitStatus').by('sha', head)) {
    if (s.get('repo_id') !== pr.base_repo_id && s.get('repo_id') !== pr.head_repo_id) continue;
    const prev = latest.get(s.get('context'));
    if (!prev || s.get('index') > prev.get('index')) latest.set(s.get('context'), s);
  }
  const runs = [...pool.model('ActionRun').by('repo_id', pr.base_repo_id)].filter((r) => r.data.commit_sha === head).sort((a, b) => b.data.id - a.data.id);
  // The latest run per workflow (a re-run or a new sync of the same commit replaces the older one).
  const byWorkflow = new Map<string, Entity<'ActionRun'>>();
  for (const r of runs) if (!byWorkflow.has(r.data.workflow_id)) byWorkflow.set(r.data.workflow_id, r);
  const current = [...byWorkflow.values()];
  // An Actions job's own status points at its run: listed with the runs, not again as a status.
  const statuses = [...latest.values()].filter((s) => !(current.length && /\/actions\/runs\/\d+/.test(s.get('target_url'))));
  const states = [...statuses.map((s) => s.get('state')), ...current.map((r) => r.data.status)];
  const summary: ChecksSummary = !states.length ? 'none' : states.some((s) => FAILED.has(s)) ? 'failure' : states.some((s) => PENDING.has(s)) ? 'pending' : 'success';
  return {statuses, runs: current, summary};
}

/** A status's description without a negative duration (a clock skew between runner and server: "Successful in -35s"). */
export function cleanDescription(text: string): string {
  return text.replace(/\s+(?:in|after)\s+-\d[\dhms ]*$/i, '');
}
