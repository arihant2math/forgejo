// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the pool's server state says about an intent: whether it already
// shows the intent's effect (then sending it changes nothing: it is done),
// and for scalars the server's current value (last writer wins, and
// overriding someone else's change is told to the user: executor.ts).

import {untracked} from 'mobx';
import type {Pool} from '../data/pool.ts';
import type {Intent} from './intents.ts';
import {serverMembers} from './view.ts';

/** Whether the pool's server state shows the intent's effect. Untracked plain reads. */
export function effectHeld(pool: Pool, i: Intent, me: number): boolean {
  return untracked(() => {
    if (i.kind === 'notification.status') return pool.model('Notification').get(i.notificationId)?.data.status === i.status;
    if (i.kind === 'notification.readAll') return i.notificationIds.every((id) => pool.model('Notification').get(id)?.data.status !== 'unread');
    const issue = pool.model('Issue').get(i.issueId)?.data;
    switch (i.kind) {
      case 'issue.create':
      case 'comment.create':
      case 'review.submit':
        return false;
      case 'issue.state':
        return issue?.state === i.state;
      case 'issue.title':
        return issue?.title === i.title;
      case 'issue.deadline':
        return issue !== undefined && (issue.due_date?.slice(0, 10) ?? null) === i.due;
      case 'issue.milestone':
        return issue?.milestone_id === i.milestoneId;
      case 'issue.pin':
        return issue !== undefined && issue.pin_order > 0 === i.pinned;
      case 'issue.lock':
        return issue?.is_locked === i.locked;
      case 'issue.body':
        return pool.model('IssueBody').get(i.issueId)?.data.body === i.text;
      case 'comment.edit':
        return pool.model('Comment').get(i.commentId)?.data.body === i.text;
      case 'comment.resolve': {
        const c = pool.model('Comment').get(i.commentId)?.data;
        return c !== undefined && c.resolve_doer_id > 0 === i.resolved;
      }
      case 'comment.delete':
        // Absent from a loaded issue group: gone (a group not here says nothing).
        return pool.groupEntities(`issue:${String(i.issueId)}`).size > 0 && !pool.model('Comment').get(i.commentId);
      case 'issue.label':
        return issue !== undefined && serverMembers(pool, 'IssueLabel', i.issueId).has(i.labelId) === i.add;
      case 'issue.assignee':
        return issue !== undefined && serverMembers(pool, 'IssueAssignee', i.issueId).has(i.userId) === i.add;
      case 'issue.dependency':
        return pool.groupEntities(`issue:${String(i.issueId)}`).size > 0 && serverMembers(pool, 'IssueDependency', i.issueId).has(i.dependencyId) === i.add;
      case 'issue.subscribe':
        return serverMembers(pool, 'IssueSubscriber', i.issueId).has(i.userId) === i.add && (i.add || pool.model('IssueWatch').by('issue_id', i.issueId).size > 0);
      case 'issue.reviewer':
        return pool.groupEntities(`issue:${String(i.issueId)}`).size > 0 && serverMembers(pool, 'ReviewRequest', i.issueId).has(i.userId) === i.add;
      case 'reaction': {
        if (pool.groupEntities(`issue:${String(i.issueId)}`).size === 0) return false;
        const set = i.commentId ? serverMembers(pool, 'CommentReaction', i.commentId, me) : serverMembers(pool, 'IssueReaction', i.issueId, me);
        return set.has(i.content) === i.add;
      }
      case 'board.move':
        // The column alone does not show the position asked for: always sent (a repeat changes nothing).
        return false;
      case 'issue.project': {
        const on = [...pool.model('ProjectIssue').by('issue_id', i.issueId)].map((p) => p.data);
        return i.projectId ? on.length === 1 && on[0]?.project_id === i.projectId && (!i.columnId || on[0].column_id === i.columnId) : on.length === 0;
      }
      case 'pr.viewed': {
        // The viewer's state saved for the intent's head only: a file viewed at an older head may have
        // changed since (and must be sent again), F7.
        const pull = [...pool.model('PullRequest').by('issue_id', i.issueId)][0];
        if (!pull) return false;
        const state = [...pool.model('ReviewState').by('pull_id', pull.id)].find((s) => s.data.user_id === me && s.data.commit_sha === i.commitSha);
        if (!state) return false;
        return Object.entries(i.files).every(([path, v]) => (state.data.updated_files[path] === 2) === v);
      }
    }
  });
}

/** Scalar intents: the server's current value of the field, compared with the intent's `base`. */
export function serverScalar(pool: Pool, i: Intent): unknown {
  return untracked(() => {
    const issue = pool.model('Issue').get(i.issueId)?.data;
    switch (i.kind) {
      case 'issue.state':
        return issue?.state;
      case 'issue.title':
        return issue?.title;
      case 'issue.milestone':
        return issue?.milestone_id;
      case 'issue.deadline':
        return issue ? (issue.due_date?.slice(0, 10) ?? null) : undefined;
      default:
        return undefined;
    }
  });
}

/** Scalar intents: the field the user changed (for the override notice). */
export function scalarField(i: Intent): string | undefined {
  switch (i.kind) {
    case 'issue.state':
      return 'status';
    case 'issue.title':
      return 'title';
    case 'issue.milestone':
      return 'milestone';
    case 'issue.deadline':
      return 'due date';
    default:
      return undefined;
  }
}

/** The comment types that record a change of a scalar field (who overrode whom). */
export const SCALAR_EVENTS: Record<string, readonly string[]> = {
  'issue.state': ['close', 'reopen', 'merge_pull'],
  'issue.title': ['change_title'],
  'issue.milestone': ['milestone'],
  'issue.deadline': ['added_deadline', 'modified_deadline', 'removed_deadline'],
};

/** Who made the latest server change of the intent's field (from the issue's timeline, when it is here). */
export function lastChangedBy(pool: Pool, i: Intent): number | undefined {
  const types = SCALAR_EVENTS[i.kind];
  if (!types) return undefined;
  return untracked(() => {
    let best: {at: string; who: number} | undefined;
    for (const c of pool.model('Comment').by('issue_id', i.issueId)) {
      if (!types.includes(c.data.type)) continue;
      if (!best || c.data.created_at > best.at) best = {at: c.data.created_at, who: c.data.poster_id};
    }
    return best?.who;
  });
}
