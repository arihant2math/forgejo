// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the UI shows of an issue: the pool's server state with the overlay's
// optimistic overrides on top. Every reader of a field an intent can change
// goes through these, so a row, the detail view and the pickers agree.
//
// Inside a reaction each accessor observes exactly what it combines — the
// issue's field (or the issue's set in the pool's index) and the overlay's
// override of it — so one change re-renders the cells that show it.
//
// Rebase (PLAN §5.4): a delta changes the server value under an override;
// the override keeps showing (no flicker) until its intent is confirmed or
// fails, and sets show the other members' changes at once (they commute).

import {PROJECT_FIELD} from './intents.ts';
import {untracked} from 'mobx';
import type {Entity} from '../data/entity.ts';
import type {Pool} from '../data/pool.ts';
import type {Comment} from '../protocol/types.gen.ts';
import {DELETED, type Member, type Overlay, type SetModel} from './overlay.ts';

export function issueState(overlay: Overlay, issue: Entity<'Issue'>): string {
  const o = overlay.field('Issue', issue.id, 'state');
  return o ? o.value as string : issue.get('state');
}

export function issueMilestone(overlay: Overlay, issue: Entity<'Issue'>): number {
  const o = overlay.field('Issue', issue.id, 'milestone_id');
  return o ? o.value as number : issue.get('milestone_id');
}

export function issueTitle(overlay: Overlay, issue: Entity<'Issue'>): string {
  const o = overlay.field('Issue', issue.id, 'title');
  return o ? o.value as string : issue.get('title');
}

/** The due date (RFC 3339) or undefined. */
export function issueDeadline(overlay: Overlay, issue: Entity<'Issue'>): string | undefined {
  const o = overlay.field('Issue', issue.id, 'due_date');
  return o ? o.value as string | undefined : issue.get('due_date');
}

export function issuePinned(overlay: Overlay, issue: Entity<'Issue'>): boolean {
  const o = overlay.field('Issue', issue.id, 'pin_order');
  return (o ? o.value as number : issue.get('pin_order')) > 0;
}

export function issueLocked(overlay: Overlay, issue: Entity<'Issue'>): boolean {
  const o = overlay.field('Issue', issue.id, 'is_locked');
  return o ? o.value as boolean : issue.get('is_locked');
}

/**
 * The description's markdown as the user sees it: `local` when an edit is
 * pending (the server's rendered HTML is not of that text), else the server's.
 * undefined while the issue's lazy group is not here.
 */
export function issueBody(pool: Pool, overlay: Overlay, issueId: number): {text: string; html: string; local: boolean} | undefined {
  const o = overlay.field('IssueBody', issueId, 'body');
  const body = pool.model('IssueBody').get(issueId) ?? overlay.createdEntity('IssueBody', issueId) as Entity<'IssueBody'> | undefined;
  if (o) return {text: o.value as string, html: '', local: true};
  if (!body) return undefined;
  return {text: body.get('body'), html: body.get('body_html'), local: body.version === 0};
}

/** A comment's markdown as the user sees it (see issueBody); `deleted` when a delete is pending. */
export function commentBody(overlay: Overlay, c: Entity<'Comment'>): {text: string; html: string; local: boolean; deleted: boolean} {
  const deleted = overlay.field('Comment', c.id, DELETED) !== undefined;
  const o = overlay.field('Comment', c.id, 'body');
  if (o) return {text: o.value as string, html: '', local: true, deleted};
  return {text: c.get('body'), html: c.get('body_html'), local: c.version === 0, deleted};
}

export function notificationStatus(overlay: Overlay, n: Entity<'Notification'>): string {
  const o = overlay.field('Notification', n.id, 'status');
  return o ? o.value as string : n.get('status');
}

/** The project an issue is on as the user sees it (a pending `issue.project` first): its id (0: none) and column (0: unknown, the default). */
export function issueProject(pool: Pool, overlay: Overlay, issueId: number): {project: number; column: number} {
  const o = overlay.field('Issue', issueId, PROJECT_FIELD);
  if (o) return o.value as {project: number; column: number};
  const [pi] = pool.model('ProjectIssue').by('issue_id', issueId);
  return pi ? {project: pi.get('project_id'), column: pi.get('column_id')} : {project: 0, column: 0};
}

/** The column of an issue's card on a project board (and its pending position), or undefined when not on it. */
export function boardCard(pool: Pool, overlay: Overlay, projectId: number, issueId: number): {column: number; position?: number} | undefined {
  const o = overlay.field('Issue', issueId, `~board:${String(projectId)}`);
  if (o) return o.value as {column: number; position: number};
  for (const pi of pool.model('ProjectIssue').by('issue_id', issueId)) {
    if (pi.get('project_id') === projectId) return {column: pi.get('column_id')};
  }
  return undefined;
}

/**
 * The server's members of a set (label ids, assignee ids, …; the viewer's
 * reaction contents; viewed paths), observing the set's membership only.
 * `me`: the viewer (reactions and viewed files are the viewer's).
 */
export function serverMembers(pool: Pool, model: SetModel, owner: number, me = 0): Set<Member> {
  const out = new Set<Member>();
  const add = <T>(rows: Iterable<T>, pick: (row: T) => Member | undefined) => {
    untracked(() => {
      for (const r of rows) {
        const m = pick(r);
        if (m !== undefined) out.add(m);
      }
    });
  };
  switch (model) {
    case 'IssueLabel':
      add(pool.model('IssueLabel').by('issue_id', owner), (e) => e.data.label_id);
      break;
    case 'IssueAssignee':
      add(pool.model('IssueAssignee').by('issue_id', owner), (e) => e.data.assignee_id);
      break;
    case 'IssueDependency':
      add(pool.model('IssueDependency').by('issue_id', owner), (e) => e.data.dependency_id);
      break;
    case 'IssueSubscriber':
      add(pool.model('IssueWatch').by('issue_id', owner), (e) => (e.data.is_watching ? e.data.user_id : undefined));
      break;
    case 'ReviewRequest':
      add(pool.model('Review').by('issue_id', owner), (e) => (e.data.state === 'REQUEST_REVIEW' ? e.data.reviewer_id : undefined));
      break;
    case 'IssueReaction':
      add(pool.model('Reaction').by('issue_id', owner), (e) => (e.data.comment_id === 0 && e.data.user_id === me ? e.data.content : undefined));
      break;
    case 'CommentReaction':
      add(pool.model('Reaction').by('comment_id', owner), (e) => (e.data.user_id === me ? e.data.content : undefined));
      break;
    case 'ViewedFile': {
      const pulls = pool.model('PullRequest').by('issue_id', owner);
      const pull = untracked(() => [...pulls][0]?.id);
      if (pull === undefined) break;
      const states = pool.model('ReviewState').by('pull_id', pull);
      untracked(() => {
        for (const s of states) {
          if (s.data.user_id !== me) continue;
          // models/pull: 2 = viewed.
          for (const [path, st] of Object.entries(s.data.updated_files)) if (st === 2) out.add(path);
        }
      });
      break;
    }
  }
  return out;
}

/** A set as the user sees it: the server's members with the overrides on top. */
export function viewMembers(pool: Pool, overlay: Overlay, model: SetModel, owner: number, me = 0): Set<Member> {
  const set = serverMembers(pool, model, owner, me);
  const o = overlay.members(model, owner);
  if (o) {
    for (const [m, present] of o) {
      if (present) set.add(m);
      else set.delete(m);
    }
  }
  return set;
}

/** The ids of the labels on an issue, as the user sees them. */
export function issueLabelIds(pool: Pool, overlay: Overlay, issueId: number): number[] {
  return [...viewMembers(pool, overlay, 'IssueLabel', issueId)] as number[];
}

/** The ids of the users assigned to an issue, as the user sees them. */
export function issueAssigneeIds(pool: Pool, overlay: Overlay, issueId: number): number[] {
  return [...viewMembers(pool, overlay, 'IssueAssignee', issueId)] as number[];
}

/**
 * Untracked: a set as the user saw it when the intent `layer` was made (the
 * server's, with the overrides of that intent and the ones before it). Sends
 * that replace a whole set (API v1's assignee list) use this.
 */
export function membersAsOf(pool: Pool, overlay: Overlay, model: SetModel, owner: number, layer: string, me = 0): Set<Member> {
  return untracked(() => {
    const set = serverMembers(pool, model, owner, me);
    for (const [m, present] of overlay.membersUpTo(model, owner, layer, true)) {
      if (present) set.add(m);
      else set.delete(m);
    }
    return set;
  });
}

/**
 * The comments of an issue as the user sees them: the pool's, without those
 * deleted locally, plus those created locally (minus a created one whose
 * server copy is already in the pool: `remapped` maps temporary ids to the
 * server's, so it never shows twice).
 */
export function issueComments(pool: Pool, overlay: Overlay, issueId: number, remapped: ReadonlyMap<number, number>): Entity<'Comment'>[] {
  const rows = pool.model('Comment').by('issue_id', issueId);
  // Few: observed (an arriving server copy hides its local one in the same batch).
  const created = (overlay.created('Comment') as Entity<'Comment'>[]).filter((c) => {
    if ((c.data as Comment).issue_id !== issueId) return false;
    const real = remapped.get(c.id);
    return real === undefined || !pool.model('Comment').get(real);
  });
  return untracked(() => [...rows, ...created]);
}

const PARTICIPATION = new Set(['comment', 'code', 'review']);

/**
 * Whether the viewer is subscribed to an issue, as Forgejo decides it
 * (models/issues CheckIssueWatch): a pending (un)subscribe; else their
 * explicit choice (IssueWatch); else watching the repository's issues
 * (Watch), or taking part — the poster, or a commenter whose comment is on
 * this device.
 */
export function issueSubscribed(pool: Pool, overlay: Overlay, issue: Entity<'Issue'>, me: number): boolean {
  const o = overlay.members('IssueSubscriber', issue.id)?.get(me);
  if (o !== undefined) return o;
  for (const w of pool.model('IssueWatch').by('issue_id', issue.id)) if (w.get('user_id') === me) return w.get('is_watching');
  for (const w of pool.model('Watch').by('repo_id', issue.get('repo_id'))) if (w.get('user_id') === me && w.get('issues')) return true;
  if (issue.get('poster_id') === me) return true;
  // Forgejo's participants: posters of comments, code comments and reviews.
  for (const c of pool.model('Comment').by('issue_id', issue.id)) if (c.get('poster_id') === me && PARTICIPATION.has(c.get('type'))) return true;
  return false;
}
