// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Placeholder for the boot route until F3 builds the real app shell.

import {Rocket} from 'lucide-react';
import {CenteredScreen, LoggedOut} from '../../app/LoggedOut.tsx';
import {hasUser, readSplash} from '../../app/splash.ts';
import {EmptyState} from '../../ui/index.ts';

export default function Home() {
  if (!hasUser(readSplash())) return <LoggedOut/>;
  return (
    <CenteredScreen>
      <EmptyState icon={Rocket} title="Forgejo Next" description="The app shell arrives with milestone F3."/>
    </CenteredScreen>
  );
}
