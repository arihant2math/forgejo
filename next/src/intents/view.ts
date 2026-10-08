// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the UI shows of an issue: the pool's server state with the overlay's
// optimistic overrides on top. Every reader of a field an intent can change
// goes through these, so a row, the detail view and the pickers agree.
//
// Inside a reaction each accessor observes exactly what it combines — the
// issue's field (or the issue's set in the pool's index) and the overlay's
// override of it — so one change re-renders the cells that show it.

import {untracked} from 'mobx';
import type {Entity} from '../data/entity.ts';
import type {Pool} from '../data/pool.ts';
import type {Overlay, SetModel} from './overlay.ts';

export function issueState(overlay: Overlay, issue: Entity<'Issue'>): string {
  const o = overlay.field('Issue', issue.id, 'state');
  return o ? o.value as string : issue.get('state');
}

export function issueMilestone(overlay: Overlay, issue: Entity<'Issue'>): number {
  const o = overlay.field('Issue', issue.id, 'milestone_id');
  return o ? o.value as number : issue.get('milestone_id');
}

/** The server's members of an issue's set (label ids or assignee ids), observing set membership only. */
export function serverMembers(pool: Pool, model: SetModel, issueId: number): Set<number> {
  const out = new Set<number>();
  if (model === 'IssueLabel') {
    const rows = pool.model('IssueLabel').by('issue_id', issueId);
    untracked(() => {
      for (const e of rows) out.add(e.data.label_id);
    });
  } else {
    const rows = pool.model('IssueAssignee').by('issue_id', issueId);
    untracked(() => {
      for (const e of rows) out.add(e.data.assignee_id);
    });
  }
  return out;
}

function members(pool: Pool, overlay: Overlay, model: SetModel, issueId: number): number[] {
  const set = serverMembers(pool, model, issueId);
  const o = overlay.members(model, issueId);
  if (o) {
    for (const [m, present] of o) {
      if (present) set.add(m);
      else set.delete(m);
    }
  }
  return [...set];
}

/** The ids of the labels on an issue, as the user sees them. */
export function issueLabelIds(pool: Pool, overlay: Overlay, issueId: number): number[] {
  return members(pool, overlay, 'IssueLabel', issueId);
}

/** The ids of the users assigned to an issue, as the user sees them. */
export function issueAssigneeIds(pool: Pool, overlay: Overlay, issueId: number): number[] {
  return members(pool, overlay, 'IssueAssignee', issueId);
}

/**
 * Untracked: an issue's set as the user saw it when the intent `layer` was
 * made (the server's, with the overrides of that intent and the ones before
 * it). Sends that replace a whole set (API v1's assignee list) use this.
 */
export function membersAsOf(pool: Pool, overlay: Overlay, model: SetModel, issueId: number, layer: string): Set<number> {
  return untracked(() => {
    const set = serverMembers(pool, model, issueId);
    for (const [m, present] of overlay.membersUpTo(model, issueId, layer, true)) {
      if (present) set.add(m);
      else set.delete(m);
    }
    return set;
  });
}
