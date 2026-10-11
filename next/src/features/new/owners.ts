// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the new repository and organization forms read from the pool: whom
// a repository can be created for (the viewer, and the organizations where
// a team of theirs is an owner team or may create repositories — upstream's
// GetOrgsCanCreateRepoByUserID), the names already taken there, and the
// templates. All of it is there in the first frame (no request); API v1
// completes it when online (NewRepo.tsx).

import type {Pool} from '../../data/pool.ts';
import type {Repository} from '../../protocol/types.gen.ts';

export interface OwnerChoice {
  id: number;
  login: string;
  /** Display name (may be empty). */
  name: string;
  avatar: string;
  org: boolean;
}

/** The viewer, then the organizations they may create repositories in (by name). */
export function repoOwners(pool: Pool, userId: number): OwnerChoice[] {
  const me = pool.model('User').get(userId)?.data;
  const out: OwnerChoice[] = me ? [{id: me.id, login: me.login, name: me.full_name, avatar: me.avatar_url, org: false}] : [];
  const orgs = new Map<number, OwnerChoice>();
  for (const tu of pool.model('TeamUser').by('user_id', userId)) {
    const team = pool.model('Team').get(tu.data.team_id)?.data;
    if (!team || (team.permission !== 'owner' && !team.can_create_org_repo) || orgs.has(team.org_id)) continue;
    const org = pool.model('User').get(team.org_id)?.data;
    if (org) orgs.set(org.id, {id: org.id, login: org.login, name: org.full_name, avatar: org.avatar_url, org: true});
  }
  return [...out, ...[...orgs.values()].sort((a, b) => a.login.localeCompare(b.login))];
}

/** Whether the owner has a repository of this name on this device (names are case-insensitive). */
export function repoTaken(pool: Pool, ownerId: number, name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower) return false;
  for (const r of pool.model('Repository').by('owner_id', ownerId)) if (r.data.name.toLowerCase() === lower) return true;
  return false;
}

/** Whether a user or organization of this name is on this device. */
export function loginTaken(pool: Pool, name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower) return false;
  for (const _ of pool.model('User').by('login', name.trim())) return true;
  for (const u of pool.model('User').all()) if (u.data.login.toLowerCase() === lower) return true;
  return false;
}

/** The template repositories on this device (the viewer may read them all: they are in the pool), by name. */
export function templateRepos(pool: Pool): Repository[] {
  return [...pool.model('Repository').all()].map((r) => r.data).filter((r) => r.template && !r.archived)
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

/**
 * Whether a new repository starts private ([repository] DEFAULT_PRIVATE): "private", "public", or "last" — the
 * visibility of the viewer's newest repository (upstream remembers the last one chosen; the newest one of theirs is
 * that on this device).
 */
export function startsPrivate(pool: Pool, userId: number, defaultPrivate: string | undefined, forced: boolean): boolean {
  if (forced || defaultPrivate === 'private') return true;
  if (defaultPrivate === 'public') return false;
  let newest: Repository | undefined;
  for (const r of pool.model('Repository').by('owner_id', userId)) if (!newest || r.data.created_at > newest.created_at) newest = r.data;
  return newest?.private ?? false;
}
