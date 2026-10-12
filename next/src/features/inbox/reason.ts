// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Reasons and actors come from issue data and server search.
// Comment bodies and review requests may be absent until the issue group is held.

import type {Pool} from '../../data/pool.ts';
import type {Notification} from '../../protocol/types.gen.ts';
import type {ServerReasons} from './serverReasons.ts';

export interface Reason {
  why: string;
  /** The user whose activity it is (0: unknown). */
  actor: number;
}

export function reasonOf(pool: Pool, n: Notification, me: number, myLogin: string | undefined, server?: ServerReasons): Reason | undefined {
  const issue = pool.model('Issue').get(n.issue_id)?.data;
  const requestedThere = server?.reviewRequested.has(n.issue_id) ?? false;
  const mentionedThere = server?.mentioned.has(n.issue_id) ?? false;
  // Server actor ids also cover comments and issues absent from this device.
  if (!issue) {
    const why = requestedThere ? 'Review requested' : mentionedThere ? 'Mentioned' : n.comment_id ? 'Commented' : 'Opened';
    return n.actor_id || requestedThere || mentionedThere ? {why, actor: n.actor_id} : undefined;
  }
  const comment = n.comment_id ? pool.model('Comment').get(n.comment_id)?.data : undefined;
  const actor = comment?.poster_id ?? (n.actor_id || (n.comment_id ? 0 : issue.poster_id));
  const requested = requestedThere || [...pool.model('Review').by('issue_id', issue.id)].some((r) => r.data.state === 'REQUEST_REVIEW' && r.data.reviewer_id === me);
  if (requested) return {why: 'Review requested', actor};
  if (mentionedThere || (comment && myLogin && new RegExp(`(^|[^\\w/])@${myLogin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(comment.body))) return {why: 'Mentioned', actor};
  const assigned = [...pool.model('IssueAssignee').by('issue_id', issue.id)].some((a) => a.data.assignee_id === me);
  if (assigned) return {why: 'Assigned', actor};
  if (issue.poster_id === me) return {why: issue.is_pull ? 'Your pull request' : 'Your issue', actor};
  return {why: n.comment_id ? 'Commented' : 'Opened', actor};
}

/** Include authors, commenters, reviewers and viewers mentioned, assigned or asked to review. */
export function participates(pool: Pool, n: Notification, me: number, myLogin: string | undefined, server?: ServerReasons): boolean {
  if (!me) return false;
  if (server?.mentioned.has(n.issue_id) || server?.reviewRequested.has(n.issue_id)) return true;
  if (pool.model('Issue').get(n.issue_id)?.data.poster_id === me) return true;
  if ([...pool.model('IssueAssignee').by('issue_id', n.issue_id)].some((a) => a.data.assignee_id === me)) return true;
  if ([...pool.model('Comment').by('issue_id', n.issue_id)].some((c) => c.data.poster_id === me)) return true;
  if ([...pool.model('Review').by('issue_id', n.issue_id)].some((r) => r.data.reviewer_id === me)) return true;
  const why = reasonOf(pool, n, me, myLogin, server)?.why;
  return why === 'Mentioned' || why === 'Review requested' || why === 'Assigned';
}
