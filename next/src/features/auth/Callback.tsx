// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// {base}callback: Forgejo's authorization page sends the browser here with
// `code` and `state` (or `error`). The code is exchanged once, then the app
// reloads at the page the sign-in started from, booting with the user's data.

import {LogIn} from 'lucide-react';
import {useEffect, useState} from 'react';
import {completeSignIn, type SignInResult} from '../../auth/signin.ts';
import {dropPreviousUser} from '../../auth/signout.ts';
import {CenteredScreen, LoggedOut} from '../../app/LoggedOut.tsx';
import {signInHere} from '../../app/session.ts';
import {type App, useApp} from '../../app/store.ts';
import {EmptyState} from '../../ui/index.ts';

// Once per page load (StrictMode runs effects twice in development).
let running: Promise<SignInResult> | undefined;

function complete(app: App): Promise<SignInResult> {
  if (!running) {
    const search = location.search;
    // The code is single-use and must not linger in the address bar or history.
    history.replaceState(history.state, '', location.pathname);
    running = completeSignIn(app.config, search, {dropUser: (id) => dropPreviousUser(id)}).catch((err: unknown) => ({
      ok: false as const, error: `Signing in failed: ${err instanceof Error ? err.message : String(err)}`, returnTo: app.config.base,
    }));
  }
  return running;
}

export default function Callback() {
  const app = useApp();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void complete(app).then((r) => {
      if (r.ok) location.replace(r.returnTo);
      else setError(r.error);
    });
  }, [app]);
  if (error) {
    return <LoggedOut message={error} onSignIn={app.config.oauth ? () => {
      signInHere(app);
    } : undefined}/>;
  }
  return (
    <CenteredScreen>
      <EmptyState icon={LogIn} title="Signing in…" description="Getting your workspace ready."/>
    </CenteredScreen>
  );
}
