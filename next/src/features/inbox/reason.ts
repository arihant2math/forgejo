// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Why a notification is in the inbox and who caused it (Linear's triage:
// decide without opening it, which would mark it read). Forgejo stores
// neither; both come from what the pool knows about the issue: a review
// asked of the viewer, an assignment, a mention in the comment that notified,
// the viewer's own issue; the comment's author, else the issue's. Pure
// (observes what it reads).

import type {Pool} from '../../data/pool.ts';
import type {Notification} from '../../protocol/types.gen.ts';

export interface Reason {
  /** "Review requested", "Assigned", "Mentioned", "Your issue", "Commented", "Opened". */
  why: string;
  /** The user whose activity it is (0: unknown). */
  actor: number;
}

export function reasonOf(pool: Pool, n: Notification, me: number, myLogin: string | undefined): Reason | undefined {
  const issue = pool.model('Issue').get(n.issue_id)?.data;
  // The server names who caused it (actor_id: the comment's author, else the issue's), also for an issue that is
  // not on this device and for a comment whose issue was never opened here.
  if (!issue) return n.actor_id ? {why: n.comment_id ? 'Commented' : 'Opened', actor: n.actor_id} : undefined;
  const comment = n.comment_id ? pool.model('Comment').get(n.comment_id)?.data : undefined;
  const actor = comment?.poster_id ?? (n.actor_id || (n.comment_id ? 0 : issue.poster_id));
  const requested = [...pool.model('Review').by('issue_id', issue.id)].some((r) => r.data.state === 'REQUEST_REVIEW' && r.data.reviewer_id === me);
  if (requested) return {why: 'Review requested', actor};
  if (comment && myLogin && new RegExp(`(^|[^\\w/])@${myLogin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(comment.body)) return {why: 'Mentioned', actor};
  const assigned = [...pool.model('IssueAssignee').by('issue_id', issue.id)].some((a) => a.data.assignee_id === me);
  if (assigned) return {why: 'Assigned', actor};
  if (issue.poster_id === me) return {why: issue.is_pull ? 'Your pull request' : 'Your issue', actor};
  return {why: n.comment_id ? 'Commented' : 'Opened', actor};
}
