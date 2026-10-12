// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {online} from '../../app/api.ts';
import {loadResource, type Resource, useResource} from '../../app/resource.ts';
import {type App, useApp, useSession} from '../../app/store.ts';

export interface OrgPermissions {is_owner: boolean; is_admin: boolean; can_create_repository?: boolean}

const NO_PERMISSIONS: OrgPermissions = {is_owner: false, is_admin: false};

function permissionsKey(owner: string, viewer: string): string {
  return `org:${owner}:permissions:${viewer}`;
}

async function fetchPermissions(app: App, owner: string, viewer: string, signal?: AbortSignal): Promise<OrgPermissions> {
  if (!viewer || !owner) return NO_PERMISSIONS;
  return await online<OrgPermissions>(app, {api: 'v1', path: `/users/${encodeURIComponent(viewer)}/orgs/${encodeURIComponent(owner)}/permissions`, signal}) ?? NO_PERMISSIONS;
}

/** The viewer's permissions in an organization; an empty owner (a user's page) asks nothing. */
export function useOrgPermissions(owner: string): Resource<OrgPermissions> {
  const app = useApp();
  const s = useSession();
  const viewer = s.data.pool.model('User').get(s.userId)?.get('login') ?? '';
  return useResource(permissionsKey(owner, viewer), (signal) => fetchPermissions(app, owner, viewer, signal));
}

/** The same permissions outside a view (one organization of many): cached, and shared with useOrgPermissions. */
export function orgPermissions(app: App, owner: string, viewer: string): Promise<OrgPermissions> {
  return loadResource(app, permissionsKey(owner, viewer), () => fetchPermissions(app, owner, viewer));
}
