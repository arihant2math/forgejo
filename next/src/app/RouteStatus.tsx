// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Link, type ErrorComponentProps} from '@tanstack/react-router';
import {FileQuestion, RefreshCw} from 'lucide-react';
import {useEffect} from 'react';
import {Button, EmptyState} from '../ui/index.ts';
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

/** A path the app has no page for. */
export function RouteNotFound() {
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
