// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {LogIn} from 'lucide-react';
import type {ReactNode} from 'react';
import {Button, cx, EmptyState} from '../ui/index.ts';

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
}

/**
 * The logged-out screen. The boot shell renders it too (boot="logged-out"),
 * so the first frame and React's first commit are identical (the button's
 * handler does not show in the markup).
 */
export function LoggedOut({boot, onSignIn, message}: LoggedOutProps) {
  const unavailable = !boot && !onSignIn;
  return (
    <CenteredScreen boot={boot}>
      <EmptyState
        icon={LogIn}
        title="Forgejo"
        description={message ?? (unavailable ? 'Signing in is not available on this server.' : 'Sign in to continue.')}
        action={<Button variant="primary" disabled={unavailable} onClick={onSignIn}>Sign in</Button>}
      />
    </CenteredScreen>
  );
}
