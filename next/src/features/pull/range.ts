// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Which changes of a pull request the Files tab shows (classic's "Show changes
// since your last review" and its commit picker, GitHub's range menu). Pure.

import type {PullCommits} from '../../code/pull.ts';
import {isSha} from '../../code/refs.ts';
import type {CommitInfo} from '../../code/source.ts';

/**
 * Every change (merge base → head), the changes since the viewer's last review (that review's commit → head), or one
 * commit's own (against its first parent: read-only, its lines are not the head's).
 */
export type DiffRange = {kind: 'all'} | {kind: 'review'; base: string} | {kind: 'commit'; sha: string};

/** The commit of the viewer's latest submitted review of the pull request, when the head moved since (else undefined). */
export function lastReviewCommit(reviews: Iterable<{id: number; reviewer_id: number; state: string; commit_id: string; created_at: string}>, me: number, head: string): string | undefined {
  let last: {id: number; commit_id: string; created_at: string} | undefined;
  for (const r of reviews) {
    if (r.reviewer_id !== me || (r.state !== 'APPROVED' && r.state !== 'REQUEST_CHANGES' && r.state !== 'COMMENT') || !isSha(r.commit_id)) continue;
    if (!last || r.created_at > last.created_at || (r.created_at === last.created_at && r.id > last.id)) last = r;
  }
  return last && last.commit_id !== head ? last.commit_id : undefined;
}

/** The diff's two commits for a range ('' base: a commit against its first parent). */
export function rangeCommits(range: DiffRange, commits: Pick<PullCommits, 'base' | 'head'>): {base: string; to: string} {
  switch (range.kind) {
    case 'all': return {base: commits.base, to: commits.head};
    case 'review': return {base: range.base, to: commits.head};
    case 'commit': return {base: '', to: range.sha};
  }
}

/**
 * How many of the pull request's commits came after `since` (an ancestor of the head among them): undefined when
 * `since` is not reached from the head (the branch was rewritten since, or the commits are not all known).
 */
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
