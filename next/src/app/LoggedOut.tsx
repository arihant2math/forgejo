// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {type ReactNode, useEffect} from 'react';
import {clsx} from 'clsx';
import {EARLY_SIGN_IN} from './splash.ts';
import {SignInIcon} from '@primer/octicons-react';
import {Button, LinkButton} from '@primer/react';
import {Blankslate} from '@primer/react/experimental';

export function CenteredScreen({boot, children}: {boot?: 'logged-out' | undefined; children: ReactNode}) {
  return <div className={clsx(boot ? 'hidden logged-out:flex' : 'flex', 'h-full items-center justify-center bg-inset')}>{children}</div>;
}

/** Forgejo's session is separate from the app's OAuth authorization, so the copy explains the extra sign-in step. */
const SIGN_IN_TEXT = 'Sign in to continue. Already signed in to Forgejo? Sign in connects Forgejo Next to your account.';

export interface LoggedOutProps {
  boot?: 'logged-out' | undefined;
  /** Undefined when OAuth2 is unavailable. */
  onSignIn?: (() => void) | undefined;
  message?: string | undefined;
  appName?: string | undefined;
  /** Public page access and opt-out in the classic UI. */
  classic?: {page?: string | undefined; optOut: string} | undefined;
}

/** Shared with the boot shell to keep the first frame identical to React's first commit. */
export function LoggedOut({boot, onSignIn, message, appName, classic}: LoggedOutProps) {
  const unavailable = !boot && !onSignIn;
  // Replay sign-in clicks captured by the splash script before React takes over.
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
      <div className="w-full max-w-md px-4">
        <Blankslate spacious>
          <Blankslate.Visual><SignInIcon size={24}/></Blankslate.Visual>
          <Blankslate.Heading>{appName ?? 'Forgejo'}</Blankslate.Heading>
          <Blankslate.Description>{message ?? (unavailable ? 'Signing in is not available on this server.' : SIGN_IN_TEXT)}</Blankslate.Description>
          <div className="mt-4 flex flex-col items-center gap-4">
            {/* The splash script stops catching early clicks once the app is ready: the marker can stay. */}
            <Button variant="primary" type="button" disabled={unavailable} onClick={onSignIn} data-early={EARLY_SIGN_IN}>Sign in</Button>
            {(boot ?? classic) && (
              // Reserve space to avoid layout shift; the app supplies the link addresses.
              <span className={clsx('flex flex-wrap justify-center gap-2', boot && 'invisible')} aria-hidden={boot ? true : undefined}>
                {classic?.page && <LinkButton variant="invisible" size="small" href={classic.page} data-classic="">View this page without signing in</LinkButton>}
                <LinkButton variant="invisible" size="small" href={classic?.optOut ?? ''} data-classic="">Turn off Forgejo Next</LinkButton>
              </span>
            )}
          </div>
        </Blankslate>
      </div>
    </CenteredScreen>
  );
}
