// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Typed intents (PLAN §5.4): what the user did, not an HTTP call. An intent
// is plain JSON — stored in IndexedDB (`intents`, store.ts) as it is — and
// pure functions derive everything else from it:
//
//   intentOps(intent)       its optimistic overlay layer (overlay.ts)
//   requestFor(intent, …)   its API call, built when it is first sent against
//                           the freshest synced state, then frozen with its
//                           Idempotency-Key (rest.ts)
//   effectHeld(pool, …)     whether the pool's server state already shows it (effects.ts)
//   chainOf / groupOf       which serial queue it is in, which sync group echoes it
//
// The queue, flush rules and conflict policies are executor.ts.
//
// Adding a kind (F6–F8): a variant below, its ops in intentOps, its words in
// describeIntent, its request in rest.ts, its effect in effects.ts, its
// policy in POLICY (and, for a create, CREATES + the response's id in
// executor.ts `createdId`), and a reader in view.ts if the UI shows it.
// Online-only actions (merge, branch operations, settings…) are never
// intents: they stay disabled offline (app/online.ts).

import {Entity} from '../data/entity.ts';
import {DELETED, type OverlayOp} from './overlay.ts';

/** Every intent names the issue (or pull request) it is about and its repository (the sync group). */
export interface IssueRef {
  /** The issue's id; a temporary (negative) id for an issue created locally (`tempNum`). */
  issueId: number;
  repoId: number;
}

interface Base extends IssueRef {
  /** Unique per intent; also the overlay layer's id. */
  id: string;
  /** Idempotency-Key of its API call: the same on every retry (B7). A new one when the request changes (a merge). */
  key: string;
  /** ms since epoch. */
  created: number;
}

/** A comment of a review (PLAN §5.4: drafted offline, sent with the review). */
export interface ReviewComment {
  path: string;
  body: string;
  /** Line in the new file (0: none). */
  newLine: number;
  /** Line in the old file (0: none). */
  oldLine: number;
}

export type Intent = Base & (
  /** A new issue under a temporary id (`tempId`; the issue's id is tempNum(tempId)). Remapped when created. */
  | {kind: 'issue.create'; tempId: string; title: string; body: string; labelIds: number[]; assigneeIds: number[]; milestoneId: number}
  /** Close or reopen. `base`: the state the user saw (override notice). */
  | {kind: 'issue.state'; state: 'open' | 'closed'; base: string}
  | {kind: 'issue.title'; title: string; base: string}
  /**
   * The description. `baseText` is what the user edited (`baseVersion` its
   * content_version, -1 when unknown: the server answers 409 with the current
   * text, which is merged). 3-way merged at flush time (merge3.ts).
   */
  | {kind: 'issue.body'; text: string; baseText: string; baseVersion: number}
  /** The due date ("YYYY-MM-DD", or null to remove it). */
  | {kind: 'issue.deadline'; due: string | null; base: string | null}
  /** Set the milestone (0: none). `base`: the milestone the user saw. */
  | {kind: 'issue.milestone'; milestoneId: number; base: number}
  | {kind: 'issue.pin'; pinned: boolean}
  | {kind: 'issue.lock'; locked: boolean; reason: string}
  /**
   * Add or remove a label. Adding an exclusive scoped label removes the
   * issue's other labels of that scope (as Forgejo does): `drop` lists those
   * the user saw on the issue, so the overlay hides them at once.
   */
  | {kind: 'issue.label'; labelId: number; add: boolean; drop: number[]}
  /** Assign or unassign a user. */
  | {kind: 'issue.assignee'; userId: number; add: boolean}
  /** This issue depends on (is blocked by) `dependencyId`. */
  | {kind: 'issue.dependency'; dependencyId: number; add: boolean}
  /** Subscribe (watch) or unsubscribe the viewer `userId`. */
  | {kind: 'issue.subscribe'; userId: number; add: boolean}
  /** Request (or withdraw) a review from a user (pull requests). */
  | {kind: 'issue.reviewer'; userId: number; add: boolean}
  /** The viewer's reaction on the issue (commentId 0) or one of its comments. */
  | {kind: 'reaction'; commentId: number; content: string; add: boolean}
  /** A new comment under a temporary id (the comment's id is tempNum(tempId)). */
  | {kind: 'comment.create'; tempId: string; body: string}
  /**
   * Edit a comment. Conflict check (PLAN §5.4): its `updated_at` must still be
   * `baseUpdated` (else the user resolves the conflict); the server checks
   * `baseVersion` again (B9, 409).
   */
  | {kind: 'comment.edit'; commentId: number; text: string; baseText: string; baseVersion: number; baseUpdated: string}
  | {kind: 'comment.delete'; commentId: number}
  /** Submit a review, pinned to the commit the user saw; its code comments were drafted locally. */
  | {kind: 'review.submit'; tempId: string; commitId: string; event: 'APPROVED' | 'REQUEST_CHANGES' | 'COMMENT'; body: string; comments: ReviewComment[]}
  /** Move a card on a project board (B9): `position` among the cards the user saw in the column. */
  | {kind: 'board.move'; projectId: number; columnId: number; position: number; baseColumn: number}
  /** Mark files of a pull request viewed or not (B9), for its head `commitSha`. */
  | {kind: 'pr.viewed'; commitSha: string; files: Record<string, boolean>}
  /** Inbox: a notification read, unread or pinned. `issueId` may be 0 (a repository notification). */
  | {kind: 'notification.status'; notificationId: number; status: 'read' | 'unread' | 'pinned'; base: string}
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

/**
 * The temporary id of a locally created entity: negative (server ids are
 * positive), the same in every tab and after a reload (derived from the
 * create's tempId), a safe integer.
 */
export function tempNum(tempId: string): number {
  const hex = tempId.replace(/-/g, '').slice(0, 13);
  return -(Number.parseInt(hex, 16) || 1);
}

/** Whether an id is a temporary one (an entity created locally, not on the server yet). */
export function isTemp(id: number): boolean {
  return id < 0;
}

/** Kinds that create an entity (their tempId is remapped to the server's id). */
export const CREATES = {'issue.create': 'Issue', 'comment.create': 'Comment', 'review.submit': 'Review'} as const;

/**
 * The conflict policy of each kind (PLAN §5.4):
 *   set       commutative add/remove against the current server set
 *   scalar    last writer wins; overriding someone else's change since `base` tells the user, with undo
 *   text      3-way merge (body) / updated_at check (comment), parked on a conflict
 *   create    temporary id remapped in the pool, the queue and the URL
 *   idempotent repeating it changes nothing (pin, lock, delete, viewed, board move, inbox)
 */
export const POLICY: Record<IntentKind, 'set' | 'scalar' | 'text' | 'create' | 'idempotent'> = {
  'issue.create': 'create', 'issue.state': 'scalar', 'issue.title': 'scalar', 'issue.body': 'text', 'issue.deadline': 'scalar',
  'issue.milestone': 'scalar', 'issue.pin': 'idempotent', 'issue.lock': 'idempotent', 'issue.label': 'set', 'issue.assignee': 'set',
  'issue.dependency': 'set', 'issue.subscribe': 'set', 'issue.reviewer': 'set', 'reaction': 'set', 'comment.create': 'create',
  'comment.edit': 'text', 'comment.delete': 'idempotent', 'review.submit': 'create', 'board.move': 'idempotent', 'pr.viewed': 'idempotent',
  'notification.status': 'idempotent',
};

/** The serial queue an intent is in (PLAN §5.4 flush rule 2: per entity). Everything about an issue is one entity. */
export function chainOf(i: Intent): string {
  return i.kind === 'notification.status' ? `n:${String(i.notificationId)}` : `i:${String(i.issueId)}`;
}

/** The sync group whose position confirms the intent's write (X-Livesync-Sync-Id, B7). */
export function groupOf(i: Intent, userId: number): string {
  switch (i.kind) {
    case 'notification.status':
    case 'pr.viewed':
      return `user:${String(userId)}`;
    case 'issue.body':
    case 'comment.create':
    case 'comment.edit':
    case 'comment.delete':
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
  if ((i.kind === 'comment.edit' || i.kind === 'comment.delete' || i.kind === 'reaction') && isTemp(i.commentId)) out.push(i.commentId);
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
  if ((i.kind === 'comment.edit' || i.kind === 'comment.delete' || i.kind === 'reaction') && i.commentId === from) set({commentId: to});
  if (i.kind === 'issue.dependency' && i.dependencyId === from) set({dependencyId: to});
  return out;
}

/** The context intentOps needs for creates (who the viewer is). */
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
    case 'pr.viewed':
      return Object.entries(i.files).map(([path, viewed]): OverlayOp => ({t: 'member', model: 'ViewedFile', owner: i.issueId, member: path, present: viewed}));
    case 'notification.status':
      return [{t: 'field', model: 'Notification', id: i.notificationId, field: 'status', value: i.status}];
  }
}

export interface Names {
  label?: (id: number) => string;
  user?: (id: number) => string;
  milestone?: (id: number) => string;
}

/** Short words for notices and the "Unsynced changes" panel ("Adding the label “bug”", …). */
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
    case 'review.submit':
      return 'Submitting a review';
    case 'board.move':
      return 'Moving a card';
    case 'pr.viewed':
      return 'Marking files viewed';
    case 'notification.status':
      return i.status === 'read' ? 'Marking a notification read' : i.status === 'unread' ? 'Marking a notification unread' : 'Pinning a notification';
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
