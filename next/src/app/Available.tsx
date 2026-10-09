// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What this device can show offline (PLAN §5.5: "Not available offline"
// lists what is — no blank screens, no spinners): the views, and the
// repositories whose data is here. Rendered by the pages that cannot show
// their own content offline.

import {Link} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {SectionHeading, TextLink} from '../ui/index.ts';
import {useApp} from './store.ts';

const VIEWS = [
  {to: '/', label: 'Home'},
  {to: '/issues', label: 'My issues'},
  {to: '/pulls', label: 'My pull requests'},
  {to: '/notifications', label: 'Inbox'},
] as const;

/** At most this many repositories are listed. */
const MAX_REPOS = 8;

export const AvailableOffline = observer(function AvailableOffline() {
  const app = useApp();
  const pool = app.session?.data.pool;
  const repos = pool ? [...pool.model('Repository').all()].map((r) => r.data).sort((a, b) => a.full_name.localeCompare(b.full_name)).slice(0, MAX_REPOS) : [];
  return (
    <nav aria-label="Available on this device" className="flex flex-col items-center gap-2">
      <SectionHeading>Available on this device</SectionHeading>
      <ul className="flex flex-col items-center gap-1 text-base">
        {VIEWS.map((v) => <li key={v.to}><TextLink><Link to={v.to}>{v.label}</Link></TextLink></li>)}
        {repos.map((r) => (
          <li key={r.id}><TextLink><Link to="/$owner/$repo" params={{owner: r.owner_name, repo: r.name}} activeOptions={{exact: true}}>{r.full_name}</Link></TextLink></li>
        ))}
      </ul>
    </nav>
  );
});
