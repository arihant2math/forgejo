// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Typed intents (PLAN §5.4): what the user did, not an HTTP call. An intent
// is plain JSON — F5 stores it in IndexedDB (`intents`) as it is — and two
// pure functions derive everything else from it:
//
//   intentOps(intent)       its optimistic overlay layer (overlay.ts)
//   requestFor(intent, …)   its API v1 call, built at send time against the
//                           freshest pool state (rest.ts)
//
// F4 runs intents online only (executor.ts): applied to the overlay at
// once, sent right away, confirmed by the sync-id echo or rolled back. F5
// keeps the same intents and ops and adds the durable queue, the flush rules
// (after caught_up, per-entity serial) and the conflict policies.

import type {OverlayOp} from './overlay.ts';

/** Every intent names the issue (or pull request) it changes; `repoId` decides the sync group. */
export interface IssueRef {
  issueId: number;
  repoId: number;
}

interface Base extends IssueRef {
  /** Unique per intent; also the overlay layer's id. */
  id: string;
  /** Idempotency-Key of its API call: the same on every retry (B7). */
  key: string;
  /** ms since epoch. */
  created: number;
}

export type Intent = Base & (
  /** Close or reopen. `base`: the state the user saw (F5: override notice). */
  | {kind: 'issue.state'; state: 'open' | 'closed'; base: string}
  /**
   * Add or remove a label. Adding an exclusive scoped label removes the
   * issue's other labels of that scope (as Forgejo does): `drop` lists those
   * the user saw on the issue, so the overlay hides them at once.
   */
  | {kind: 'issue.label'; labelId: number; add: boolean; drop: number[]}
  /** Assign or unassign a user. */
  | {kind: 'issue.assignee'; userId: number; add: boolean}
  /** Set the milestone (0: none). `base`: the milestone the user saw. */
  | {kind: 'issue.milestone'; milestoneId: number; base: number}
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

/** The overlay layer of an intent (pure). */
export function intentOps(i: Intent): OverlayOp[] {
  switch (i.kind) {
    case 'issue.state':
      return [{t: 'field', model: 'Issue', id: i.issueId, field: 'state', value: i.state}];
    case 'issue.milestone':
      return [{t: 'field', model: 'Issue', id: i.issueId, field: 'milestone_id', value: i.milestoneId}];
    case 'issue.label':
      return [
        {t: 'member', model: 'IssueLabel', owner: i.issueId, member: i.labelId, present: i.add},
        ...i.drop.filter((l) => l !== i.labelId).map((l): OverlayOp => ({t: 'member', model: 'IssueLabel', owner: i.issueId, member: l, present: false})),
      ];
    case 'issue.assignee':
      return [{t: 'member', model: 'IssueAssignee', owner: i.issueId, member: i.userId, present: i.add}];
  }
}

/** Short words for notices ("adding the label", …). */
export function describeIntent(i: Intent, names: {label?: (id: number) => string; user?: (id: number) => string; milestone?: (id: number) => string} = {}): string {
  switch (i.kind) {
    case 'issue.state':
      return i.state === 'closed' ? 'Closing the issue' : 'Reopening the issue';
    case 'issue.label': {
      const n = names.label?.(i.labelId);
      return `${i.add ? 'Adding' : 'Removing'} the label${n ? ` “${n}”` : ''}`;
    }
    case 'issue.assignee': {
      const n = names.user?.(i.userId);
      return `${i.add ? 'Assigning' : 'Unassigning'}${n ? ` ${n}` : ''}`;
    }
    case 'issue.milestone': {
      const n = i.milestoneId ? names.milestone?.(i.milestoneId) : undefined;
      return i.milestoneId ? `Setting the milestone${n ? ` “${n}”` : ''}` : 'Clearing the milestone';
    }
  }
}

/**
 * Where intents are kept until they are confirmed or given up. F4 keeps them
 * in memory (a reload forgets unsent ones, as nothing is sent offline); F5
 * implements this over IndexedDB's `intents` store and replays them.
 */
export interface IntentStore {
  put(i: Intent): void;
  delete(id: string): void;
  list(): Intent[];
}

export class MemoryIntentStore implements IntentStore {
  private readonly map = new Map<string, Intent>();
  put(i: Intent): void {
    this.map.set(i.id, i);
  }
  delete(id: string): void {
    this.map.delete(id);
  }
  list(): Intent[] {
    return [...this.map.values()];
  }
}
