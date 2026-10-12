// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Deduplicate Actions jobs: Forgejo also reports them as commit statuses linked to their runs.

import {CheckIcon, DotFillIcon, XIcon, type Icon} from '@primer/octicons-react';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import type {PullRequest} from '../../protocol/types.gen.ts';

export type ChecksSummary = 'none' | 'pending' | 'failure' | 'success';

export const CHECK_SUMMARY: Record<ChecksSummary, {icon: Icon; tone: string; label: string}> = {
  none: {icon: DotFillIcon, tone: 'text-muted', label: 'No checks'},
  success: {icon: CheckIcon, tone: 'text-success', label: 'All checks have passed'},
  failure: {icon: XIcon, tone: 'text-danger', label: 'Some checks were not successful'},
  pending: {icon: DotFillIcon, tone: 'text-attention', label: "Some checks haven't completed yet"},
};

export interface Checks {
  statuses: Entity<'CommitStatus'>[];
  runs: Entity<'ActionRun'>[];
  summary: ChecksSummary;
  awaitingApproval: number;
}

export type CheckRepos = Pick<PullRequest, 'base_repo_id' | 'head_repo_id'>;

const PENDING = new Set(['pending', 'waiting', 'running', 'blocked']);
const FAILED = new Set(['failure', 'error', 'cancelled']);

/** Keep Actions job statuses: branch protection requires them even when the UI deduplicates runs. */
export function latestStatuses(pool: Pool, pr: CheckRepos, head: string): Entity<'CommitStatus'>[] {
  const latest = new Map<string, Entity<'CommitStatus'>>();
  for (const s of pool.model('CommitStatus').by('sha', head)) {
    if (s.get('repo_id') !== pr.base_repo_id && s.get('repo_id') !== pr.head_repo_id) continue;
    const prev = latest.get(s.get('context'));
    if (!prev || s.get('index') > prev.get('index')) latest.set(s.get('context'), s);
  }
  return [...latest.values()];
}

export function summarize(states: readonly string[]): ChecksSummary {
  return !states.length ? 'none' : states.some((s) => FAILED.has(s)) ? 'failure' : states.some((s) => PENDING.has(s)) ? 'pending' : 'success';
}

export function awaitsApproval(run: {need_approval: boolean; status: string}): boolean {
  return run.need_approval && PENDING.has(run.status);
}

export function checksOf(pool: Pool, pr: CheckRepos, head: string): Checks {
  const latest = latestStatuses(pool, pr, head);
  const runs = [...pool.model('ActionRun').by('commit_sha', head)].filter((r) => r.data.repo_id === pr.base_repo_id).sort((a, b) => b.data.id - a.data.id);
  const byWorkflow = new Map<string, Entity<'ActionRun'>>();
  for (const r of runs) if (!byWorkflow.has(r.data.workflow_id)) byWorkflow.set(r.data.workflow_id, r);
  const current = [...byWorkflow.values()];
  const statuses = latest.filter((s) => !(current.length && /\/actions\/runs\/\d+/.test(s.get('target_url'))));
  const summary = summarize([...statuses.map((s) => s.get('state')), ...current.map((r) => r.data.status)]);
  return {statuses, runs: current, summary, awaitingApproval: current.filter((r) => awaitsApproval(r.data)).length};
}

/** Count unfinished run jobs individually, matching the Checks tab; standalone statuses count once. */
export function unfinishedChecks(pool: Pool, c: Checks): number {
  let n = c.statuses.filter((s) => PENDING.has(s.get('state'))).length;
  for (const r of c.runs) {
    const jobs = [...pool.model('ActionRunJob').by('run_id', r.id)];
    n += jobs.length ? jobs.filter((j) => PENDING.has(j.data.status)).length : Number(PENDING.has(r.data.status));
  }
  return n;
}

/** Hide negative durations caused by runner/server clock skew. */
export function cleanDescription(text: string): string {
  return text.replace(/\s+(?:in|after)\s+-\d[\dhms ]*$/i, '');
}
