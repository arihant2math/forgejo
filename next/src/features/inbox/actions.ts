// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Inbox triage as intents (`notification.status`: offline-capable, PLAN §5.4).

import {runInAction, untracked} from 'mobx';
import type {App} from '../../app/store.ts';
import type {Entity} from '../../data/entity.ts';
import {editing} from '../../intents/session.ts';
import {notificationStatus} from '../../intents/view.ts';

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
