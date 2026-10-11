// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Inbox triage as intents (`notification.status`: offline-capable, PLAN §5.4).

import {runInAction, untracked} from 'mobx';
import type {App} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {issueSubscribed, notificationStatus} from '../../intents/view.ts';
import {subjectOf} from './subject.ts';
import {notify} from '../../app/notices.ts';

export function unsubscribeReason(app: App, ids: readonly number[]): string | undefined {
  for (const id of ids) {
    const n = app.session?.data.pool.model('Notification').get(id);
    if (!n || (n.data.subject !== 'issue' && n.data.subject !== 'pull')) return 'Only issue and pull request threads can be unsubscribed';
    if (!app.session?.data.pool.model('Issue').get(n.data.issue_id) && !subjectOf(app, n.data)) return 'Thread details are not available on this device yet';
  }
  return undefined;
}

/** Queue thread changes together and keep the prior read/subscription state for Undo. */
export function unsubscribe(app: App, ids: readonly number[], markRead = false): void {
  const s = app.session;
  if (!s || !ids.length || unsubscribeReason(app, ids)) return;
  const {overlay, intents} = editing(app);
  const before = ids.flatMap((id) => {
    const n = s.data.pool.model('Notification').get(id);
    if (!n) return [];
    const issue = s.data.pool.model('Issue').get(n.data.issue_id);
    const target = issue ? undefined : subjectOf(app, n.data);
    return [{id, status: notificationStatus(overlay, n), subscribed: issue ? issueSubscribed(s.data.pool, overlay, issue, s.userId) : overlay.members('IssueSubscriber', n.data.issue_id)?.get(s.userId) ?? true,
      intent: {kind: 'issue.subscribe' as const, issueId: n.data.issue_id, repoId: n.data.repo_id, userId: s.userId, ...(target ? {target: {owner: target.owner, repo: target.repo, number: target.number}} : {})}}];
  });
  runInAction(() => {
    for (const row of before) intents.submit({...row.intent, add: false});
    if (markRead) setStatus(app, ids, (st) => st === 'unread' ? 'read' : undefined);
  });
  notify(app, {tone: 'neutral', series: 'inbox', title: `Unsubscribed from ${String(before.length)} thread${before.length === 1 ? '' : 's'}${markRead ? ' and marked read' : ''}`, action: {label: 'Undo', run: () => {
    runInAction(() => {
      for (const row of before) {
        intents.submit({...row.intent, add: row.subscribed});
        if (markRead && (row.status === 'read' || row.status === 'unread' || row.status === 'pinned')) setStatus(app, [row.id], () => row.status as 'read' | 'unread' | 'pinned');
      }
    });
  }}});
}

/** Sets the status of notifications (one intent each; nothing for those already there). */
export function setStatus(app: App, ids: readonly number[], to: (current: string) => 'read' | 'unread' | 'pinned' | undefined): void {
  const s = app.session;
  if (!s) return;
  const {overlay, intents} = editing(app);
  runInAction(() => {
    for (const id of ids) {
      const n = untracked(() => s.data.pool.model('Notification').get(id));
      if (!n) continue;
      const current = untracked(() => notificationStatus(overlay, n));
      const next = to(current);
      if (!next || next === current) continue;
      const d = untracked(() => n.data);
      intents.submit({kind: 'notification.status', notificationId: id, issueId: d.issue_id, repoId: d.repo_id, status: next, base: current});
    }
  });
}


/**
 * Marks notifications read in one request ("Mark all read"): those unread now, up to the newest of them (one
 * intent; Forgejo's bulk endpoint). Returns the ids it marked (for Undo).
 */
export function readAll(app: App, ids: readonly number[]): number[] {
  const s = app.session;
  if (!s) return [];
  const {overlay, intents} = editing(app);
  const unread = untracked(() => ids.map((id) => s.data.pool.model('Notification').get(id))
    .filter((n): n is Entity<'Notification'> => n !== undefined && notificationStatus(overlay, n) === 'unread'));
  if (!unread.length) return [];
  const lastReadAt = untracked(() => unread.reduce((max, n) => (n.data.updated_at > max ? n.data.updated_at : max), ''));
  const notificationIds = unread.map((n) => n.id);
  runInAction(() => {
    intents.submit({kind: 'notification.readAll', issueId: 0, repoId: 0, notificationIds, lastReadAt});
  });
  return notificationIds;
}
