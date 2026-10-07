// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Placeholder for the boot route until F3 builds the real app shell.

import {LogIn, Rocket} from 'lucide-react';
import {readSplash} from '../../app/splash.ts';
import {Button, EmptyState} from '../../ui/index.ts';

export default function Home() {
  const signedIn = Boolean(readSplash().user);
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      {signedIn ?
        <EmptyState icon={Rocket} title="Forgejo Next" description="The app shell arrives with milestone F3."/> :
        <EmptyState
          icon={LogIn}
          title="Forgejo"
          description="Sign in to continue."
          action={<Button variant="primary" disabled>Sign in</Button>}
        />}
    </div>
  );
}
