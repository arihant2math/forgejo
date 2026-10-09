// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the viewer may do in a repository (the controls a page offers: edit,
// pick, merge, drag). Read from the pool first — the viewer's synced Access
// rows (Forgejo's computed access table, group user:{id}) and ownership — so
// it is known offline and in the first frame; refined once per repository
// and session by API v1's `permissions` when online (site administrators
// have no Access rows; an org owner's team rows may lag a membership
// change). The server still decides every write: this only hides what would
// be refused.

import {observable, runInAction} from 'mobx';
import {useEffect} from 'react';
import {sitePath} from './config.ts';
import type {App, Session} from './store.ts';

export type AccessLevel = 'read' | 'write' | 'admin';

const RANK: Record<string, AccessLevel | undefined> = {read: 'read', write: 'write', admin: 'admin', owner: 'admin'};

/** API v1 answers (repository id → level), per session. */
const confirmed = observable.map<number, AccessLevel>();
const asked = new Set<number>();

/** The viewer's access to a repository (observes the pool). Unknown repositories read as "read". */
export function repoAccess(s: Session, repoId: number): AccessLevel {
  const api = confirmed.get(repoId);
  if (api) return api;
  const repo = s.data.pool.model('Repository').get(repoId);
  if (repo?.get('owner_id') === s.userId) return 'admin';
  let best: AccessLevel = 'read';
  for (const a of s.data.pool.model('Access').by('repo_id', repoId)) {
    if (a.get('user_id') !== s.userId) continue;
    const level = RANK[a.get('permission')];
    if (level === 'admin' || (level === 'write' && best === 'read')) best = level;
  }
  return best;
}

/** Whether the viewer may change the repository's issues and pull requests (labels, state, assignees, merge, boards). */
export function canWrite(s: Session, repoId: number): boolean {
  return repoAccess(s, repoId) !== 'read';
}

/** Asks API v1 once per session for the viewer's permissions in a repository (online; errors are ignored). */
export function confirmAccess(app: App, owner: string, repo: string, repoId: number): void {
  const s = app.session;
  if (!s || asked.has(repoId) || !navigator.onLine) return;
  asked.add(repoId);
  void (async () => {
    try {
      const token = await s.auth.token();
      const res = await fetch(sitePath(app.config, `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`), {
        headers: {Authorization: `Bearer ${token}`, Accept: 'application/json'}, credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        asked.delete(repoId);
        return;
      }
      const p = (await res.json() as {permissions?: {admin?: boolean; push?: boolean}}).permissions;
      if (!p) return;
      runInAction(() => {
        confirmed.set(repoId, p.admin ? 'admin' : p.push ? 'write' : 'read');
      });
    } catch {
      asked.delete(repoId);
    }
  })();
}

/** Confirms the viewer's access while a repository's page is open. */
export function useConfirmAccess(app: App, owner: string, repo: string, repoId: number | undefined): void {
  useEffect(() => {
    if (repoId !== undefined && owner && repo) confirmAccess(app, owner, repo, repoId);
  }, [app, owner, repo, repoId]);
}

/**
 * Whether the viewer may change a board (move cards, edit columns): a repository's board needs write access to
 * the repository; an organization's, a team of it with write access (or its projects unit); a user's, the user.
 */
export function canEditBoard(s: Session, project: {repo_id: number; owner_id: number}): boolean {
  if (project.repo_id) return canWrite(s, project.repo_id);
  if (project.owner_id === s.userId) return true;
  const pool = s.data.pool;
  for (const tu of pool.model('TeamUser').by('user_id', s.userId)) {
    const team = pool.model('Team').get(tu.get('team_id'))?.data;
    if (team?.org_id !== project.owner_id) continue;
    if (team.permission === 'owner' || team.permission === 'admin' || team.permission === 'write') return true;
    for (const u of pool.model('TeamUnit').by('team_id', team.id)) if (u.get('type') === 'projects' && (u.get('permission') === 'write' || u.get('permission') === 'admin')) return true;
  }
  return false;
}
