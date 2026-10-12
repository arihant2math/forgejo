// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// All intent-editable reads combine server state with pending overlays so every view agrees.
// Observe only the fields/sets combined; keep overrides until confirmation to avoid flicker.

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

/** local text has no matching server HTML; undefined means the lazy issue group is not loaded. */
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

/** Observes set membership only; me selects the viewer’s reactions and viewed files. */
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

export function issueLabelIds(pool: Pool, overlay: Overlay, issueId: number): number[] {
  return [...viewMembers(pool, overlay, 'IssueLabel', issueId)] as number[];
}

export function issueAssigneeIds(pool: Pool, overlay: Overlay, issueId: number): number[] {
  return [...viewMembers(pool, overlay, 'IssueAssignee', issueId)] as number[];
}

/** Untracked set state including layer and preceding overrides, for whole-set API writes. */
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

/** Omits local deletions and deduplicates created comments against server copies using remapped ids. */
export function issueComments(pool: Pool, overlay: Overlay, issueId: number, remapped: ReadonlyMap<number, number>): Entity<'Comment'>[] {
  const rows = pool.model('Comment').by('issue_id', issueId);
  // Observe server-copy arrival so it hides the local entity in the same batch.
  const created = (overlay.created('Comment') as Entity<'Comment'>[]).filter((c) => {
    if ((c.data as Comment).issue_id !== issueId) return false;
    const real = remapped.get(c.id);
    return real === undefined || !pool.model('Comment').get(real);
  });
  return untracked(() => [...rows, ...created]);
}

const PARTICIPATION = new Set(['comment', 'code', 'review']);

/** Pending subscription overrides explicit IssueWatch; otherwise use repository watching or participation. */
export function issueSubscribed(pool: Pool, overlay: Overlay, issue: Entity<'Issue'>, me: number): boolean {
  const o = overlay.members('IssueSubscriber', issue.id)?.get(me);
  if (o !== undefined) return o;
  for (const w of pool.model('IssueWatch').by('issue_id', issue.id)) if (w.get('user_id') === me) return w.get('is_watching');
  for (const w of pool.model('Watch').by('repo_id', issue.get('repo_id'))) if (w.get('user_id') === me && w.get('issues')) return true;
  if (issue.get('poster_id') === me) return true;
  for (const c of pool.model('Comment').by('issue_id', issue.id)) if (c.get('poster_id') === me && PARTICIPATION.has(c.get('type'))) return true;
  return false;
}

/** Pending resolve wins; returns resolver id (0 means open). */
export function commentResolver(overlay: Overlay, c: Entity<'Comment'>): number {
  const o = overlay.field('Comment', c.id, 'resolve_doer_id');
  return o ? o.value as number : c.get('resolve_doer_id');
}
