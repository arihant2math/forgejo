// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import type {InboxSearch} from '../../app/search.ts';
import type {Notification} from '../../protocol/types.gen.ts';

export type InboxRow =
  | {type: 'group'; key: string; label: string; count: number}
  | {type: 'note'; id: number};

export interface InboxView extends Pick<InboxSearch, 'reason' | 'repo' | 'type' | 'state'> {
  /** Pinned notifications do not count as unread. */
  unread: boolean;
  /** Include unread and pinned, excluding read notifications. */
  working?: boolean | undefined;
  /** Group by repository (else: pinned, then the rest). */
  byRepo: boolean;
}

export interface InboxContext {
  /** The status as the user sees it (pending read/unread/pin included). */
  status(n: Notification): string;
  repoName(repoId: number): string;
  reason?: (n: Notification) => InboxSearch['reason'];
  subject?: (n: Notification) => {type: 'issue' | 'pr'; state: string} | undefined;
  /** Subject activity time: status changes also update notification.updated_at but must not reorder rows. */
  activity?: ((n: Notification) => string) | undefined;
}

/** Use earlier issue activity to exclude later notification status changes. */
export function activityOf(n: Notification, issueUpdated: string | undefined): string {
  return issueUpdated !== undefined && issueUpdated < n.updated_at ? issueUpdated : n.updated_at;
}

export interface InboxResult {
  rows: InboxRow[];
  /** The notifications in display order. */
  ids: number[];
}

export function inboxRows(notes: Iterable<Notification>, view: InboxView, ctx: InboxContext): InboxResult {
  const at = ctx.activity ?? ((n: Notification) => n.updated_at);
  const newestFirst = (a: Notification, b: Notification) => {
    const x = at(a);
    const y = at(b);
    return x < y ? 1 : x > y ? -1 : b.id - a.id;
  };
  const pinned: Notification[] = [];
  const rest: Notification[] = [];
  for (const n of notes) {
    const st = ctx.status(n);
    if (view.unread && st !== 'unread') continue;
    if (view.working && st !== 'unread' && st !== 'pinned') continue;
    if (view.repo !== undefined && n.repo_id !== view.repo) continue;
    if (view.reason && ctx.reason?.(n) !== view.reason) continue;
    if (view.type || view.state) {
      const subject = ctx.subject?.(n);
      if (!subject || (view.type && subject.type !== view.type) || (view.state && subject.state !== view.state)) continue;
    }
    (st === 'pinned' ? pinned : rest).push(n);
  }
  pinned.sort(newestFirst);
  rest.sort(newestFirst);
  const rows: InboxRow[] = [];
  const ids: number[] = [];
  const push = (key: string, label: string, list: readonly Notification[]) => {
    if (!list.length) return;
    rows.push({type: 'group', key, label, count: list.length});
    for (const n of list) {
      rows.push({type: 'note', id: n.id});
      ids.push(n.id);
    }
  };
  push('pinned', 'Pinned', pinned);
  if (!view.byRepo) {
    if (pinned.length) push('rest', 'Latest', rest);
    else for (const n of rest) {
      rows.push({type: 'note', id: n.id});
      ids.push(n.id);
    }
    return {rows, ids};
  }
  const groups = new Map<number, Notification[]>();
  for (const n of rest) {
    let g = groups.get(n.repo_id);
    if (!g) groups.set(n.repo_id, g = []);
    g.push(n);
  }
  for (const [repoId, list] of groups) push(`repo:${String(repoId)}`, ctx.repoName(repoId) || 'Other', list);
  return {rows, ids};
}

export function togglePin(status: string): 'read' | 'pinned' {
  return status === 'pinned' ? 'read' : 'pinned';
}

/** Comment anchor, or undefined for the issue itself; Forgejo keeps the first comment since last read. */
export function noteHash(n: Pick<Notification, 'comment_id'>): string | undefined {
  return n.comment_id > 0 ? `comment-${String(n.comment_id)}` : undefined;
}
