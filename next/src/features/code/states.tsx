// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What a code view shows while its content is not there: a skeleton while it
// loads, "Not available offline" (with what is) when it is not on this
// device, the server's refusal otherwise. Never a spinner.

import {CloudOff, SearchX, TriangleAlert} from 'lucide-react';
import type {ReactNode} from 'react';
import {AvailableOffline} from '../../app/Available.tsx';
import {EmptyState, Skeleton} from '../../ui/index.ts';
import type {Loaded} from './hooks.ts';

export function Unloaded({loaded, what, skeleton}: {loaded: Exclude<Loaded<unknown>, {state: 'ready'}>; what: string; skeleton?: ReactNode}) {
  switch (loaded.state) {
    case 'loading':
      return skeleton ?? <div className="flex flex-col gap-2 px-6 py-4" aria-busy><Skeleton className="h-3 w-64"/><Skeleton className="h-3 w-48"/></div>;
    case 'offline':
      return <EmptyState icon={CloudOff} title="Not available offline" description={`${what} is not on this device. Connect to load it, or open one of these:`} action={<AvailableOffline/>}/>;
    case 'error':
      if (loaded.status === 404) return <EmptyState icon={SearchX} title="Not found" description={`${what} does not exist, or you cannot see it.`}/>;
      if (loaded.status === 413) return <EmptyState icon={TriangleAlert} title="Too large to show here" description={`${what} is too large for this view: open it in the classic UI.`}/>;
      if (loaded.message === 'signed out' || loaded.message.includes('SignedOut')) return <EmptyState icon={CloudOff} title="Signed out" description="Sign in again (the sync indicator above) to load this."/>;
      return <EmptyState icon={TriangleAlert} title="Could not load" description={loaded.message}/>;
  }
}
