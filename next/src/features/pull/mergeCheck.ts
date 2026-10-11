// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What Forgejo says about merging a pull request, for its viewer (the gap
// endpoint GET /-/sync/api/issues/{id}/merge-check, APIMergeCheck): the base
// branch's protection verdict, whether the viewer may merge or delete the
// head branch, and whether workflow runs wait for a maintainer. API v1's
// protection rules are for repository administrators only (a writer got a
// 403 and lost every merge rule), so the merge box reads this instead.

import {observable, runInAction} from 'mobx';
import type {Entity} from '../../data/entity.ts';
import type {Pool} from '../../data/pool.ts';
import type {APIMergeCheck, PullRequest} from '../../protocol/types.gen.ts';

/** Bumped after a write the merge check answers differently to (trust, a deleted branch): asked again. */
const revisions = observable.map<number, number>();

export function revision(issueId: number): number {
  return revisions.get(issueId) ?? 0;
}

export function bumpMergeCheck(issueId: number): void {
  runInAction(() => {
    revisions.set(issueId, revision(issueId) + 1);
  });
}

export function mergeCheckPath(issueId: number): string {
  return `/issues/${String(issueId)}/merge-check`;
}

/**
 * The key of a pull request's merge check (observes what changes its answer: the head, the state, the reviews,
 * runs that wait for approval, the head branch): a new key asks Forgejo again.
 */
export function mergeCheckKey(pool: Pool, issue: Entity<'Issue'>, pr: PullRequest, head: string | undefined): string {
  const reviews = [...pool.model('Review').by('issue_id', issue.id)].map((r) => `${String(r.id)}:${r.data.state}:${String(r.data.dismissed)}`).join(',');
  const runs = [...pool.model('ActionRun').by('repo_id', pr.base_repo_id)].filter((r) => r.data.pull_request_id === pr.id && r.data.need_approval).map((r) => r.id).join(',');
  const branch = [...pool.model('Branch').by('repo_id', pr.head_repo_id)].find((b) => b.data.name === pr.head_branch);
  return [
    'merge-check', issue.id, head ?? '', pr.status, pr.merged, issue.get('state'), issue.get('title'), pr.commits_behind, pr.base_branch,
    reviews, runs, branch ? `${branch.data.commit_id}:${String(branch.data.is_deleted)}` : '', revision(issue.id),
  ].join(':');
}

/** A protection rule's status check pattern (Forgejo's glob: `*`, `?`, `[…]`, `{a,b}`, `\` escapes) as a RegExp. */
export function globRegExp(pattern: string): RegExp {
  let out = '';
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? '';
    if (c === '\\' && i + 1 < pattern.length) {
      out += escape(pattern[++i] ?? '');
    } else if (c === '*') {
      out += '.*';
    } else if (c === '?') {
      out += '.';
    } else if (c === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end < 0) {
        out += '\\[';
        continue;
      }
      let set = pattern.slice(i + 1, end);
      const negate = set.startsWith('!');
      if (negate) set = set.slice(1);
      out += `[${negate ? '^' : ''}${set.replace(/[\\\]^]/g, '\\$&')}]`;
      i = end;
    } else if (c === '{') {
      braces++;
      out += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      out += ')';
    } else if (c === ',' && braces > 0) {
      out += '|';
    } else {
      out += escape(c);
    }
  }
  try {
    return new RegExp(`^${out}${')'.repeat(braces)}$`);
  } catch {
    return new RegExp(`^${escape(pattern)}$`);
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * The required check patterns not passed yet, as Forgejo decides (MergeRequiredContextsCommitStatus): a pattern
 * passes when some latest status matches it and every one that does succeeded.
 */
export function unmetChecks(patterns: readonly string[], statuses: readonly {context: string; state: string}[]): string[] {
  return patterns.filter((p) => {
    const re = globRegExp(p);
    const matched = statuses.filter((s) => s.context === p || re.test(s.context));
    return !matched.length || matched.some((s) => s.state !== 'success');
  });
}

/** Why the base branch's protection keeps the viewer from merging now (the merge API's refusals), or undefined. */
export function protectionWhy(check: APIMergeCheck | undefined, base: string, statuses: readonly {context: string; state: string}[]): string | undefined {
  if (!check) return undefined;
  const p = check.protection ?? undefined;
  if (!check.allow_merge) return p ? `Only users on the merge allowlist of ${base} can merge.` : `You may not merge into ${base}.`;
  if (!p) return undefined;
  const unmet = unmetChecks(p.required_checks, statuses);
  if (unmet.length) return `Required checks have not passed: ${unmet.join(', ')}.`;
  if (p.blocked_by_approvals) {
    const n = Math.max(1, p.required_approvals - p.granted_approvals);
    return `Needs ${String(n)} more approval${n === 1 ? '' : 's'} (${String(p.granted_approvals)} of ${String(p.required_approvals)}).`;
  }
  if (p.blocked_by_rejection) return 'Blocked by a change request.';
  if (p.blocked_by_official_review_requests) return 'Waiting for requested official reviews.';
  if (p.blocked_by_outdated_branch) return `The branch is behind ${base}: update it first.`;
  if (p.blocked_by_protected_files) return `Changes protected files: ${p.changed_protected_files.join(', ')}.`;
  return undefined;
}
