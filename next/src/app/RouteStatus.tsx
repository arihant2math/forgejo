// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Link, type ErrorComponentProps} from '@tanstack/react-router';
import {CloudOff, FileQuestion, RefreshCw} from 'lucide-react';
import {useEffect} from 'react';
import {Button, EmptyState} from '../ui/index.ts';
import {AvailableOffline} from './Available.tsx';
import {CenteredScreen} from './LoggedOut.tsx';
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
 * A path the app has no page for. Offline, the service worker answers every
 * navigation with the app: a classic page is then "not available offline",
 * and what is available is listed.
 */
export function RouteNotFound() {
  if (!navigator.onLine) {
    return (
      <CenteredScreen>
        <EmptyState
          icon={CloudOff}
          title="Not available offline"
          description="This page needs a connection. These work offline:"
          action={<div className="flex flex-col items-center gap-4"><AvailableOffline/><Button onClick={() => { location.reload(); }}>Try again</Button></div>}
        />
      </CenteredScreen>
    );
  }
  return (
    <CenteredScreen>
      <EmptyState
        icon={FileQuestion}
        title="Page not found"
        description="Forgejo Next has no page at this address."
        action={<Button asChild><Link to="/">Go home</Link></Button>}
      />
    </CenteredScreen>
  );
}
