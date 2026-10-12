// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Intents are plain JSON, not HTTP requests; online-only actions are not queued.
// New kinds need overlay ops, descriptions, requests, effects, and a conflict policy.
// Creates also need CREATES and response-id handling; view.ts must read any optimistic fields.

import {Entity} from '../data/entity.ts';
import {DELETED, type OverlayOp} from './overlay.ts';

/** The overlay field of an issue's pending project (`issue.project`): {project, column}. */
export const PROJECT_FIELD = '~project';

export interface IssueRef {
  /** The issue's id; a temporary (negative) id for an issue created locally (`tempNum`). */
  issueId: number;
  repoId: number;
}

interface Base extends IssueRef {
  /** Unique per intent; also the overlay layer's id. */
  id: string;
  /** Stable Idempotency-Key on retries; replace it when the request changes. */
  key: string;
  /** ms since epoch. */
  created: number;
}

/** Drafted locally until its review is submitted. */
export interface ReviewComment {
  path: string;
  body: string;
  /** Line in the new file (0: none). */
  newLine: number;
  /** Line in the old file (0: none). */
  oldLine: number;
}

export type Intent = Base & (
  /** tempNum(tempId) is remapped to the server id after creation. */
  | {kind: 'issue.create'; tempId: string; title: string; body: string; labelIds: number[]; assigneeIds: number[]; milestoneId: number}
  /** `base` is the state the user saw, used for override notices. */
  | {kind: 'issue.state'; state: 'open' | 'closed'; base: string}
  | {kind: 'issue.title'; title: string; base: string}
  /** baseVersion is content_version (-1 if unknown); merge baseText with current text at flush time. */
  | {kind: 'issue.body'; text: string; baseText: string; baseVersion: number}
  /** The due date ("YYYY-MM-DD", or null to remove it). */
  | {kind: 'issue.deadline'; due: string | null; base: string | null}
  /** Set the milestone (0: none). `base`: the milestone the user saw. */
  | {kind: 'issue.milestone'; milestoneId: number; base: number}
  | {kind: 'issue.pin'; pinned: boolean}
  | {kind: 'issue.lock'; locked: boolean; reason: string}
  /** `drop` lists the scoped labels hidden optimistically when adding an exclusive label. */
  | {kind: 'issue.label'; labelId: number; add: boolean; drop: number[]}
  | {kind: 'issue.assignee'; userId: number; add: boolean}
  /** This issue depends on (is blocked by) `dependencyId`. */
  | {kind: 'issue.dependency'; dependencyId: number; add: boolean}
  /** Subscribe (watch) or unsubscribe the viewer `userId`. */
  | {kind: 'issue.subscribe'; userId: number; add: boolean; target?: {owner: string; repo: string; number: number}}
  | {kind: 'issue.reviewer'; userId: number; add: boolean}
  /** The viewer's reaction on the issue (commentId 0) or one of its comments. */
  | {kind: 'reaction'; commentId: number; content: string; add: boolean}
  /** The comment id is tempNum(tempId) until remapped. */
  | {kind: 'comment.create'; tempId: string; body: string}
  /** Park if updated_at differs from baseUpdated; the server also checks baseVersion. */
  | {kind: 'comment.edit'; commentId: number; text: string; baseText: string; baseVersion: number; baseUpdated: string}
  | {kind: 'comment.delete'; commentId: number}
  | {kind: 'comment.resolve'; commentId: number; resolved: boolean}
  /** Submit a review, pinned to the commit the user saw; its code comments were drafted locally. */
  | {kind: 'review.submit'; tempId: string; commitId: string; event: 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT'; body: string; comments: ReviewComment[]}
  /** One project per issue; projectId 0 removes it, columnId 0 uses the default column’s end. */
  | {kind: 'issue.project'; projectId: number; columnId: number; base: number}
  /** `position` is relative to the cards the user saw in the column. */
  | {kind: 'board.move'; projectId: number; columnId: number; position: number; baseColumn: number}
  /** Viewed state applies only to commitSha. */
  | {kind: 'pr.viewed'; commitSha: string; files: Record<string, boolean>}
  /** Inbox: a notification read, unread or pinned. `issueId` may be 0 (a repository notification). */
  | {kind: 'notification.status'; notificationId: number; status: 'read' | 'unread' | 'pinned'; base: string}
  /** Marks unread notifications updated through lastReadAt (the newest visible timestamp); issueId/repoId are 0. */
  | {kind: 'notification.readAll'; notificationIds: number[]; lastReadAt: string}
);

export type IntentKind = Intent['kind'];

/** An intent as the caller describes it (id, key and time are filled in). */
export type IntentInput = Intent extends infer I ? I extends Intent ? Omit<I, 'id' | 'key' | 'created'> : never : never;

export function newIntent(input: IntentInput, now = Date.now()): Intent {
  return {...input, id: uuid(), key: uuid(), created: now};
}

/** A fresh RFC 4122 v4 UUID (crypto.randomUUID needs a secure context; dev servers on plain http are not). */
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function' && globalThis.isSecureContext) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A deterministic negative safe integer, stable across tabs and reloads; server ids are positive. */
export function tempNum(tempId: string): number {
  const hex = tempId.replace(/-/g, '').slice(0, 13);
  return -(Number.parseInt(hex, 16) || 1);
}

export function isTemp(id: number): boolean {
  return id < 0;
}

export const CREATES = {'issue.create': 'Issue', 'comment.create': 'Comment', 'review.submit': 'Review'} as const;

/** Sets commute; scalars override with undo notices; text conflicts park; creates remap temporary ids. */
export const POLICY: Record<IntentKind, 'set' | 'scalar' | 'text' | 'create' | 'idempotent'> = {
  'issue.create': 'create', 'issue.state': 'scalar', 'issue.title': 'scalar', 'issue.body': 'text', 'issue.deadline': 'scalar',
  'issue.milestone': 'scalar', 'issue.pin': 'idempotent', 'issue.lock': 'idempotent', 'issue.label': 'set', 'issue.assignee': 'set',
  'issue.dependency': 'set', 'issue.project': 'idempotent', 'issue.subscribe': 'set', 'issue.reviewer': 'set', 'reaction': 'set', 'comment.create': 'create',
  'comment.edit': 'text', 'comment.delete': 'idempotent', 'comment.resolve': 'idempotent', 'review.submit': 'create', 'board.move': 'idempotent', 'pr.viewed': 'idempotent',
  'notification.status': 'idempotent', 'notification.readAll': 'idempotent',
};

/** Serializes each entity; board moves share a chain because positions depend on preceding moves. */
export function chainOf(i: Intent): string {
  // The inbox is one queue: a notification marked unread right after "Mark all read" reaches Forgejo after it.
  if (i.kind === 'notification.status' || i.kind === 'notification.readAll') return 'n:inbox';
  if (i.kind === 'board.move') return `b:${String(i.projectId)}`;
  // Independent properties have separate queues so retries cannot block unrelated issue edits.
  const own = OWN_CHAIN[i.kind];
  if (own) return `i:${String(i.issueId)}:${own}`;
  return `i:${String(i.issueId)}`;
}

/** Dependent state, label, title, body, milestone, and comment edits share the issue chain. */
const OWN_CHAIN: Partial<Record<IntentKind, string>> = {
  'issue.pin': 'pin', 'issue.lock': 'lock', 'issue.subscribe': 'subscribe', 'issue.reviewer': 'reviewer', 'issue.deadline': 'deadline',
  'issue.assignee': 'assignee', 'issue.dependency': 'dependency', 'issue.project': 'project', 'pr.viewed': 'viewed', 'reaction': 'reaction',
  'comment.resolve': 'resolve',
};

/** The group whose X-Livesync-Sync-Id confirms the write. */
export function groupOf(i: Intent, userId: number): string {
  switch (i.kind) {
    case 'notification.status':
    case 'notification.readAll':
    case 'pr.viewed':
      return `user:${String(userId)}`;
    case 'issue.body':
    case 'comment.create':
    case 'comment.edit':
    case 'comment.delete':
    case 'comment.resolve':
    case 'reaction':
    case 'review.submit':
    case 'issue.dependency':
      return `issue:${String(i.issueId)}`;
    default:
      return `repo:${String(i.repoId)}`;
  }
}

/** The temporary ids an intent refers to besides its own create (it waits until they are created). */
export function tempRefs(i: Intent): number[] {
  const out: number[] = [];
  if (isTemp(i.issueId) && i.kind !== 'issue.create') out.push(i.issueId);
  if ((i.kind === 'comment.edit' || i.kind === 'comment.delete' || i.kind === 'comment.resolve' || i.kind === 'reaction') && isTemp(i.commentId)) out.push(i.commentId);
  if (i.kind === 'issue.dependency' && isTemp(i.dependencyId)) out.push(i.dependencyId);
  return out;
}

/** The intent with a temporary id replaced by the server's (pure; the same object when nothing changes). */
export function remapIntent(i: Intent, from: number, to: number): Intent {
  let out = i;
  const set = (patch: Partial<Intent>) => {
    out = {...out, ...patch} as Intent;
  };
  if (i.issueId === from) set({issueId: to});
  if ((i.kind === 'comment.edit' || i.kind === 'comment.delete' || i.kind === 'comment.resolve' || i.kind === 'reaction') && i.commentId === from) set({commentId: to});
  if (i.kind === 'issue.dependency' && i.dependencyId === from) set({dependencyId: to});
  return out;
}

export interface OpsContext {
  userId: number;
}

/** The overlay layer of an intent (pure). */
export function intentOps(i: Intent, ctx: OpsContext = {userId: 0}): OverlayOp[] {
  const field = (model: 'Issue', field: string, value: unknown): OverlayOp => ({t: 'field', model, id: i.issueId, field, value});
  switch (i.kind) {
    case 'issue.create': {
      const at = new Date(i.created).toISOString();
      return [
        {t: 'create', entity: new Entity('Issue', i.issueId, `repo:${String(i.repoId)}`, 0, {
          id: i.issueId, repo_id: i.repoId, number: 0, poster_id: ctx.userId, original_author: '', original_author_id: 0, title: i.title,
          content_version: 0, milestone_id: i.milestoneId, priority: 0, state: 'open', is_pull: false, comments: 0, ref: '', pin_order: 0,
          is_locked: false, created_at: at, updated_at: at,
        })},
        {t: 'create', entity: new Entity('IssueBody', i.issueId, `issue:${String(i.issueId)}`, 0, {id: i.issueId, repo_id: i.repoId, body: i.body, body_html: '', content_version: 0})},
        ...i.labelIds.map((l): OverlayOp => ({t: 'member', model: 'IssueLabel', owner: i.issueId, member: l, present: true})),
        ...i.assigneeIds.map((u): OverlayOp => ({t: 'member', model: 'IssueAssignee', owner: i.issueId, member: u, present: true})),
      ];
    }
    case 'issue.state':
      return [field('Issue', 'state', i.state)];
    case 'issue.title':
      return [field('Issue', 'title', i.title)];
    case 'issue.body':
      return [{t: 'field', model: 'IssueBody', id: i.issueId, field: 'body', value: i.text}];
    case 'issue.deadline':
      return [field('Issue', 'due_date', i.due === null ? undefined : `${i.due}T00:00:00Z`)];
    case 'issue.milestone':
      return [field('Issue', 'milestone_id', i.milestoneId)];
    case 'issue.pin':
      return [field('Issue', 'pin_order', i.pinned ? 1 : 0)];
    case 'issue.lock':
      return [field('Issue', 'is_locked', i.locked)];
    case 'issue.label':
      return [
        {t: 'member', model: 'IssueLabel', owner: i.issueId, member: i.labelId, present: i.add},
        ...i.drop.filter((l) => l !== i.labelId).map((l): OverlayOp => ({t: 'member', model: 'IssueLabel', owner: i.issueId, member: l, present: false})),
      ];
    case 'issue.assignee':
      return [{t: 'member', model: 'IssueAssignee', owner: i.issueId, member: i.userId, present: i.add}];
    case 'issue.dependency':
      return [{t: 'member', model: 'IssueDependency', owner: i.issueId, member: i.dependencyId, present: i.add}];
    case 'issue.subscribe':
      return [{t: 'member', model: 'IssueSubscriber', owner: i.issueId, member: i.userId, present: i.add}];
    case 'issue.reviewer':
      return [{t: 'member', model: 'ReviewRequest', owner: i.issueId, member: i.userId, present: i.add}];
    case 'reaction':
      return [i.commentId ?
        {t: 'member', model: 'CommentReaction', owner: i.commentId, member: i.content, present: i.add} :
        {t: 'member', model: 'IssueReaction', owner: i.issueId, member: i.content, present: i.add}];
    case 'comment.create': {
      const id = tempNum(i.tempId);
      const at = new Date(i.created).toISOString();
      return [{t: 'create', entity: new Entity('Comment', id, `issue:${String(i.issueId)}`, 0, {
        id, issue_id: i.issueId, type: 'comment', poster_id: ctx.userId, original_author: '', original_author_id: 0, body: i.body, body_html: '',
        content_version: 0, label_id: 0, old_project_id: 0, project_id: 0, old_milestone_id: 0, milestone_id: 0, time_id: 0, assignee_id: 0,
        assignee_team_id: 0, removed_assignee: false, resolve_doer_id: 0, old_title: '', new_title: '', old_ref: '', new_ref: '',
        dependent_issue_id: 0, line: 0, extra_lines_count: 0, path: '', diff_hunk: '', commit_id: '', review_id: 0, invalidated: false,
        ref_repo_id: 0, ref_issue_id: 0, ref_comment_id: 0, ref_action: 0, ref_is_pull: false, created_at: at, updated_at: at,
      })}];
    }
    case 'comment.edit':
      return [{t: 'field', model: 'Comment', id: i.commentId, field: 'body', value: i.text}];
    case 'comment.delete':
      return [{t: 'field', model: 'Comment', id: i.commentId, field: DELETED, value: true}];
    case 'comment.resolve':
      return [{t: 'field', model: 'Comment', id: i.commentId, field: 'resolve_doer_id', value: i.resolved ? ctx.userId : 0}];
    case 'review.submit': {
      const id = tempNum(i.tempId);
      const at = new Date(i.created).toISOString();
      return [{t: 'create', entity: new Entity('Review', id, `issue:${String(i.issueId)}`, 0, {
        id, issue_id: i.issueId, state: i.event, reviewer_id: ctx.userId, reviewer_team_id: 0, original_author: '', body: i.body, body_html: '',
        official: false, commit_id: i.commitId, stale: false, dismissed: false, created_at: at, updated_at: at,
      })}];
    }
    case 'board.move':
      return [field('Issue', `~board:${String(i.projectId)}`, {column: i.columnId, position: i.position})];
    case 'issue.project':
      return [field('Issue', PROJECT_FIELD, {project: i.projectId, column: i.columnId})];
    case 'pr.viewed':
      return Object.entries(i.files).map(([path, viewed]): OverlayOp => ({t: 'member', model: 'ViewedFile', owner: i.issueId, member: path, present: viewed}));
    case 'notification.status':
      return [{t: 'field', model: 'Notification', id: i.notificationId, field: 'status', value: i.status}];
    case 'notification.readAll':
      return i.notificationIds.map((id): OverlayOp => ({t: 'field', model: 'Notification', id, field: 'status', value: 'read'}));
  }
}

export interface Names {
  label?: (id: number) => string;
  user?: (id: number) => string;
  milestone?: (id: number) => string;
  /** An issue's number (undefined: not on the device, or not created yet). */
  issue?: (id: number) => number | undefined;
}

/** Adds an issue number for notices outside its page; omits it when unknown. */
export function withIssue(title: string, issueNumber: number | undefined): string {
  if (issueNumber === undefined) return title;
  const ref = `#${String(issueNumber)}`;
  if (title.includes('the issue')) return title.replace('the issue', ref);
  const prep = /^(Adding|Assigning)\b/.test(title) ? 'to' : /^(Removing|Unassigning)\b/.test(title) ? 'from' : 'on';
  return `${title} ${prep} ${ref}`;
}

export function describeIntent(i: Intent, names: Names = {}): string {
  const q = (s: string | undefined) => (s ? ` “${s}”` : '');
  switch (i.kind) {
    case 'issue.create':
      return `Creating the issue${q(i.title)}`;
    case 'issue.state':
      return i.state === 'closed' ? 'Closing the issue' : 'Reopening the issue';
    case 'issue.title':
      return `Renaming the issue to${q(i.title) || ' an empty title'}`;
    case 'issue.body':
      return 'Editing the description';
    case 'issue.deadline':
      return i.due ? `Setting the due date to ${i.due}` : 'Removing the due date';
    case 'issue.label':
      return `${i.add ? 'Adding' : 'Removing'} the label${q(names.label?.(i.labelId))}`;
    case 'issue.assignee': {
      const n = names.user?.(i.userId);
      return `${i.add ? 'Assigning' : 'Unassigning'}${n ? ` ${n}` : ''}`;
    }
    case 'issue.milestone':
      return i.milestoneId ? `Setting the milestone${q(names.milestone?.(i.milestoneId))}` : 'Clearing the milestone';
    case 'issue.pin':
      return i.pinned ? 'Pinning the issue' : 'Unpinning the issue';
    case 'issue.lock':
      return i.locked ? 'Locking the conversation' : 'Unlocking the conversation';
    case 'issue.dependency':
      return i.add ? 'Adding a dependency' : 'Removing a dependency';
    case 'issue.subscribe':
      return i.add ? 'Subscribing' : 'Unsubscribing';
    case 'issue.reviewer': {
      const n = names.user?.(i.userId);
      return `${i.add ? 'Requesting a review from' : 'Withdrawing the review request of'}${n ? ` ${n}` : ' a reviewer'}`;
    }
    case 'reaction':
      return `${i.add ? 'Reacting with' : 'Removing the reaction'} :${i.content}:`;
    case 'comment.create':
      return 'Posting a comment';
    case 'comment.edit':
      return 'Editing a comment';
    case 'comment.delete':
      return 'Deleting a comment';
    case 'comment.resolve':
      return i.resolved ? 'Resolving a conversation' : 'Reopening a conversation';
    case 'review.submit':
      return 'Submitting a review';
    case 'board.move':
      return 'Moving a card';
    case 'issue.project':
      return i.projectId ? 'Putting the issue on a board' : 'Taking the issue off its board';
    case 'pr.viewed':
      return 'Marking files viewed';
    case 'notification.status':
      return i.status === 'read' ? 'Marking a notification read' : i.status === 'unread' ? 'Marking a notification unread' : 'Pinning a notification';
    case 'notification.readAll':
      return `Marking ${String(i.notificationIds.length)} ${i.notificationIds.length === 1 ? 'notification' : 'notifications'} read`;
  }
}

/** The text a user typed in an intent (kept in drafts when it fails), if any. */
export function intentText(i: Intent): string | undefined {
  switch (i.kind) {
    case 'issue.create':
      return i.body ? `${i.title}\n\n${i.body}` : i.title;
    case 'issue.title':
      return i.title;
    case 'issue.body':
    case 'comment.edit':
      return i.text;
    case 'comment.create':
      return i.body;
    case 'review.submit':
      return [i.body, ...i.comments.map((c) => `${c.path}:${String(c.newLine || c.oldLine)}\n${c.body}`)].filter(Boolean).join('\n\n');
    default:
      return undefined;
  }
}
