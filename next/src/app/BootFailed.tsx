// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {RefreshCw} from 'lucide-react';
import {Button, EmptyState} from '../ui/index.ts';
import {CenteredScreen} from './LoggedOut.tsx';

/** Shown when the boot route's chunk still fails after one reload. */
export function BootFailed() {
  return (
    <CenteredScreen>
      <EmptyState
        icon={RefreshCw}
        title="Forgejo could not load"
        description="Check your connection, then reload."
        action={<Button variant="primary" onClick={() => { location.reload(); }}>Reload</Button>}
      />
    </CenteredScreen>
  );
}
