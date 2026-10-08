// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The inbox's rows (pure): notifications as the user sees them (statuses
// through the overlay), pinned first, then newest first, optionally grouped
// by repository (groups ordered by their latest activity). Like the issue
// lists, the rows are fixed-height items: group headers and notifications.

import type {Notification} from '../../protocol/types.gen.ts';

export type InboxRow =
  | {type: 'group'; key: string; label: string; count: number}
  | {type: 'note'; id: number};

export interface InboxView {
  /** Unread only (pinned notifications are not unread: they leave this view). */
  unread: boolean;
  /** Group by repository (else: pinned, then the rest). */
  byRepo: boolean;
}

export interface InboxContext {
  /** The status as the user sees it (pending read/unread/pin included). */
  status(n: Notification): string;
  repoName(repoId: number): string;
}

export interface InboxResult {
  rows: InboxRow[];
  /** The notifications in display order. */
  ids: number[];
}

const newestFirst = (a: Notification, b: Notification) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id);

export function inboxRows(notes: Iterable<Notification>, view: InboxView, ctx: InboxContext): InboxResult {
  const pinned: Notification[] = [];
  const rest: Notification[] = [];
  for (const n of notes) {
    const st = ctx.status(n);
    if (view.unread && st !== 'unread') continue;
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
    // A header only when it separates something (pinned above).
    if (pinned.length) push('rest', 'Latest', rest);
    else for (const n of rest) {
      rows.push({type: 'note', id: n.id});
      ids.push(n.id);
    }
    return {rows, ids};
  }
  // Repositories in the order of their newest notification (rest is sorted already).
  const groups = new Map<number, Notification[]>();
  for (const n of rest) {
    let g = groups.get(n.repo_id);
    if (!g) groups.set(n.repo_id, g = []);
    g.push(n);
  }
  for (const [repoId, list] of groups) push(`repo:${String(repoId)}`, ctx.repoName(repoId) || 'Other', list);
  return {rows, ids};
}

/** The status a "pin" toggle sets: pinned ones are unpinned (read), others pinned. */
export function togglePin(status: string): 'read' | 'pinned' {
  return status === 'pinned' ? 'read' : 'pinned';
}
