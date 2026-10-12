// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {observer} from 'mobx-react-lite';
import {NavList} from '@primer/react';
import {RepoIcon} from '@primer/octicons-react';
import {useApp} from './store.ts';
import {RouterNavItem} from './routerLinks.tsx';

const VIEWS = [
  {to: '/', label: 'Home'},
  {to: '/issues', label: 'My issues'},
  {to: '/pulls', label: 'My pull requests'},
  {to: '/notifications', label: 'Inbox'},
] as const;
const MAX_REPOS = 8;

export const AvailableOffline = observer(function AvailableOffline() {
  const app = useApp();
  const pool = app.session?.data.pool;
  const repos = pool ? [...pool.model('Repository').all()].map((r) => r.data).sort((a, b) => a.full_name.localeCompare(b.full_name)).slice(0, MAX_REPOS) : [];
  return (
    <NavList aria-label="Available on this device" className="w-full max-w-sm">
      <NavList.Heading as="h2">Available on this device</NavList.Heading>
      {VIEWS.map((v) => <RouterNavItem key={v.to} to={v.to}>{v.label}</RouterNavItem>)}
      {repos.length > 0 && <NavList.Group title="Repositories">
        {repos.map((r) => (
          <RouterNavItem key={r.id} to="/$owner/$repo" params={{owner: r.owner_name, repo: r.name}} activeOptions={{exact: true}}>
            <NavList.LeadingVisual><RepoIcon/></NavList.LeadingVisual>{r.full_name}
          </RouterNavItem>
        ))}
      </NavList.Group>}
    </NavList>
  );
});
