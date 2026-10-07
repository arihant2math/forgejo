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

/**
 * The logged-out screen. The boot shell renders it too (boot="logged-out"),
 * so the first frame and React's first commit are identical. The sign-in flow
 * arrives with F3.
 */
export function LoggedOut({boot}: {boot?: 'logged-out' | undefined}) {
  return (
    <CenteredScreen boot={boot}>
      <EmptyState icon={LogIn} title="Forgejo" description="Sign in to continue." action={<Button variant="primary" disabled>Sign in</Button>}/>
    </CenteredScreen>
  );
}
