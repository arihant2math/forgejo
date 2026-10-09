// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {LogIn} from 'lucide-react';
import {type ReactNode, useEffect} from 'react';
import {Button, cx, EmptyState} from '../ui/index.ts';
import {EARLY_SIGN_IN} from './splash.ts';

/** A full-height screen with its content centred (logged-out, placeholders). */
export function CenteredScreen({boot, children}: {boot?: 'logged-out' | undefined; children: ReactNode}) {
  // In the boot shell the splash attribute decides whether it shows.
  return <div className={cx(boot ? 'hidden logged-out:flex' : 'flex', 'h-full items-center justify-center bg-canvas')}>{children}</div>;
}

export interface LoggedOutProps {
  boot?: 'logged-out' | undefined;
  /** Starts signing in; undefined when this server cannot (OAuth2 off) — the text says so. */
  onSignIn?: (() => void) | undefined;
  /** Shown instead of the default text (e.g. a sign-in error). */
  message?: string | undefined;
  /** The instance's name (the title; the static first frame says "Forgejo"). */
  appName?: string | undefined;
  /** This address in the classic UI (public pages read without signing in), and the way to turn the app off. */
  classic?: {page: string; optOut: string} | undefined;
}

/**
 * The logged-out screen. The boot shell renders it too (boot="logged-out"),
 * so the first frame and React's first commit are identical (the button's
 * handler does not show in the markup).
 */
export function LoggedOut({boot, onSignIn, message, appName, classic}: LoggedOutProps) {
  const unavailable = !boot && !onSignIn;
  // A "Sign in" clicked in the first frame, before this code was here: carried out now. From here on the
  // button's own handler answers (the splash script stops catching clicks).
  useEffect(() => {
    if (boot) return;
    const html = document.documentElement;
    html.dataset.ready = '1';
    if (html.dataset.early === EARLY_SIGN_IN) {
      delete html.dataset.early;
      onSignIn?.();
    }
  }, [boot, onSignIn]);
  return (
    <CenteredScreen boot={boot}>
      <EmptyState
        icon={LogIn}
        title={appName ?? 'Forgejo'}
        description={message ?? (unavailable ? 'Signing in is not available on this server.' : 'Sign in to continue.')}
        action={
          <span className="flex flex-col items-center gap-3">
            {/* The splash script stops catching early clicks once the app is ready: the marker can stay. */}
            <Button variant="primary" disabled={unavailable} onClick={onSignIn} data-early={EARLY_SIGN_IN}>Sign in</Button>
            {(boot ?? classic) && (
              // The first frame keeps their place (no shift when the app fills them in): their addresses need the app.
              <span className={cx('flex flex-wrap justify-center gap-x-3 text-sm', boot && 'invisible')} aria-hidden={boot ? true : undefined}>
                {/* Public pages read without an account in the classic UI; or this browser leaves the app. */}
                <Button size="sm" variant="ghost" asChild><a href={classic?.page} data-classic="">View this page without signing in</a></Button>
                <Button size="sm" variant="ghost" asChild><a href={classic?.optOut} data-classic="">Turn off Forgejo Next</a></Button>
              </span>
            )}
          </span>
        }
      />
    </CenteredScreen>
  );
}
