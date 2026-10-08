// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ErrorComponentProps} from '@tanstack/react-router';
import {observer} from 'mobx-react-lite';
import {CloudOff, FileQuestion, RefreshCw} from 'lucide-react';
import {useEffect} from 'react';
import {Button, EmptyState} from '../ui/index.ts';
import {AvailableOffline} from './Available.tsx';
import {CenteredScreen} from './LoggedOut.tsx';
import {connectivity} from './online.ts';
import {isChunkError, reloadOnce} from './reload.ts';

/** A route failed to load or render. A missing chunk (an old build) reloads once. */
export function RouteError({error}: ErrorComponentProps) {
  const chunk = isChunkError(error);
  useEffect(() => {
    if (chunk) reloadOnce();
  }, [chunk]);
  return (
    <CenteredScreen>
      <EmptyState
        icon={RefreshCw}
        title="This page could not load"
        description="Check your connection, then reload."
        action={<Button variant="primary" onClick={() => { location.reload(); }}>Reload</Button>}
      />
    </CenteredScreen>
  );
}

/**
 * A path the app has no page for. The service worker answers every
 * navigation it cannot get from the network with the app (offline, or the
 * server unreachable), so this is also the page of a classic page that is not
 * available offline: it says so, and lists what is available.
 */
export const RouteNotFound = observer(function RouteNotFound() {
  const online = connectivity.online;
  return (
    <CenteredScreen>
      <EmptyState
        icon={online ? FileQuestion : CloudOff}
        title={online ? 'Not available here' : 'Not available offline'}
        description={online ?
          'Forgejo Next has no page at this address, or Forgejo could not be reached. Try again, or open one of these:' :
          'This page needs a connection. These work offline:'}
        action={<Button onClick={() => { location.reload(); }}>Try again</Button>}
      />
      <AvailableOffline/>
    </CenteredScreen>
  );
});
