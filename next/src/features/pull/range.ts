// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import type {PullCommits} from '../../code/pull.ts';
import {isSha} from '../../code/refs.ts';
import type {CommitInfo} from '../../code/source.ts';

/** Single-commit ranges use the first parent and are read-only because their lines are not the head's. */
export type DiffRange = {kind: 'all'} | {kind: 'review'; base: string} | {kind: 'commit'; sha: string};

/** undefined when the viewer has no submitted review behind the current head. */
export function lastReviewCommit(reviews: Iterable<{id: number; reviewer_id: number; state: string; commit_id: string; created_at: string}>, me: number, head: string): string | undefined {
  let last: {id: number; commit_id: string; created_at: string} | undefined;
  for (const r of reviews) {
    if (r.reviewer_id !== me || (r.state !== 'APPROVED' && r.state !== 'REQUEST_CHANGES' && r.state !== 'COMMENT') || !isSha(r.commit_id)) continue;
    if (!last || r.created_at > last.created_at || (r.created_at === last.created_at && r.id > last.id)) last = r;
  }
  return last && last.commit_id !== head ? last.commit_id : undefined;
}

/** An empty base means diff the commit against its first parent. */
export function rangeCommits(range: DiffRange, commits: Pick<PullCommits, 'base' | 'head'>): {base: string; to: string} {
  switch (range.kind) {
    case 'all': return {base: commits.base, to: commits.head};
    case 'review': return {base: range.base, to: commits.head};
    case 'commit': return {base: '', to: range.sha};
  }
}

/** undefined when since is unreachable from head, including rewritten branches or incomplete commit data. */
export function commitsSince(commits: readonly Pick<CommitInfo, 'sha' | 'parents'>[], head: string, since: string): number | undefined {
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const seen = new Set<string>();
  const todo = [head];
  let reached = false;
  for (let sha = todo.pop(); sha !== undefined; sha = todo.pop()) {
    if (sha === since) {
      reached = true;
      continue;
    }
    const c = bySha.get(sha);
    if (!c || seen.has(sha)) continue;
    seen.add(sha);
    todo.push(...c.parents);
  }
  return reached ? seen.size : undefined;
}
