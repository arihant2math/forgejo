// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ErrorComponentProps, useRouterState} from '@tanstack/react-router';
import {useEffect} from 'react';
import {observer} from 'mobx-react-lite';
import {reach} from './online.ts';
import {CenteredScreen} from './LoggedOut.tsx';
import {lazyComponent} from './lazy.tsx';
import {classicHas, classicPathOf} from './paths.ts';
import {isChunkError, reloadOnce} from './reload.ts';
import {offlineTitle} from './missingWords.ts';
import {PageBody} from './shell/Frame.tsx';
import {PageHeader} from './shell/PageHeader.tsx';
import {useApp} from './store.ts';
import {QuestionIcon, SyncIcon} from '@primer/octicons-react';
import {Blankslate} from '@primer/react/experimental';

/** Lazy to keep the rare not-found body off the boot route. */
const Missing = lazyComponent(() => import('./Missing.tsx').then((m) => m.Missing));

/** Reloads once for a missing chunk; otherwise displays the route error. */
export function RouteError({error}: ErrorComponentProps) {
  const chunk = isChunkError(error);
  useEffect(() => {
    if (chunk) reloadOnce();
  }, [chunk]);
  return (
    <CenteredScreen>
      <Blankslate>
        <Blankslate.Visual><SyncIcon size={24}/></Blankslate.Visual>
        <Blankslate.Heading>This page could not load</Blankslate.Heading>
        <Blankslate.Description>Check your connection, then reload.</Blankslate.Description>
        <Blankslate.PrimaryAction type="button" onClick={() => { location.reload(); }}>Reload</Blankslate.PrimaryAction>
      </Blankslate>
    </CenteredScreen>
  );
}

/** Returns a classic path only when a page is known to exist there but not in the app. */
function useClassicOfHere(): string | undefined {
  const app = useApp();
  const path = useRouterState({select: (s) => s.location.pathname});
  const classic = classicPathOf(path, {login: app.session?.data.pool.model('User').get(app.session.userId)?.get('login')});
  // A canonical route has a page here (it is not missing); the base and the callback are not classic pages.
  return classic === '/' || classic === path || !classicHas(classic) ? undefined : classic;
}

/** The service worker's offline fallback can land on a classic-only page; offer locally available pages. */
export const ShellNotFound = observer(function ShellNotFound() {
  const classic = useClassicOfHere();
  const app = useApp();
  const r = reach(app.session?.data.status.connection);
  const title = r !== 'online' ? offlineTitle(r) : classic ? 'Not available here' : 'Not found';
  return (
    <>
      <PageHeader icon={QuestionIcon} title={title}/>
      <PageBody>
        <Missing what="This page" description={classic ? 'Forgejo Next has no page for this address yet. The classic UI has it.' : 'There is no page at this address.'} classic={classic}/>
      </PageBody>
    </>
  );
});

export function RouteNotFound() {
  const classic = useClassicOfHere();
  return (
    <CenteredScreen>
      <Missing what="This page" description="There is no page at this address." classic={classic}/>
    </CenteredScreen>
  );
}
