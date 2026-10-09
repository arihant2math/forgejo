// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ErrorComponentProps, useRouterState} from '@tanstack/react-router';
import {FileQuestion, RefreshCw} from 'lucide-react';
import {useEffect} from 'react';
import {Button, EmptyState} from '../ui/index.ts';
import {CenteredScreen} from './LoggedOut.tsx';
import {lazyComponent} from './lazy.tsx';
import {classicHas, classicPathOf} from './paths.ts';
import {isChunkError, reloadOnce} from './reload.ts';
import {PageBody} from './shell/Frame.tsx';
import {PageHeader} from './shell/PageHeader.tsx';
import {useApp} from './store.ts';

/** The not-found page's body (and the classic link) in its own chunk: rare, and off the boot route. */
const Missing = lazyComponent(() => import('./Missing.tsx').then((m) => m.Missing));

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
 * The classic page of an address the app has no page for, when the classic UI is known to have it (a
 * repository's wiki or settings); undefined for an address nobody has (no promise of a page that is a 404).
 */
function useClassicOfHere(): string | undefined {
  const app = useApp();
  const path = useRouterState({select: (s) => s.location.pathname});
  const classic = classicPathOf(path, {login: app.session?.data.pool.model('User').get(app.session.userId)?.get('login')});
  // A canonical route has a page here (it is not missing); the base and the callback are not classic pages.
  return classic === '/' || classic === path || !classicHas(classic) ? undefined : classic;
}

/**
 * A path the app has no page for, inside the shell (the sidebar stays). The
 * service worker answers every navigation it cannot get from the network
 * with the app (offline, or the server unreachable), so this is also the
 * page of a classic page that is not available offline: it says so, and
 * lists what is available; online it offers the classic page.
 */
export function ShellNotFound() {
  const classic = useClassicOfHere();
  return (
    <>
      <PageHeader icon={FileQuestion} title="Not found"/>
      <PageBody>
        <Missing what="This page" description={classic ? 'Forgejo Next has no page for this address yet. The classic UI has it.' : 'There is no page at this address.'} classic={classic}/>
      </PageBody>
    </>
  );
}

/** The same outside the shell (no route matched at all, e.g. signed out). */
export function RouteNotFound() {
  const classic = useClassicOfHere();
  return (
    <CenteredScreen>
      <Missing what="This page" description="There is no page at this address." classic={classic}/>
    </CenteredScreen>
  );
}
