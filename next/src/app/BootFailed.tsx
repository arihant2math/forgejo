// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {EmptyState} from '../ui/index.ts';
import {CenteredScreen} from './LoggedOut.tsx';
import {SyncIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';

/** Shown when the boot route's chunk still fails after one reload. */
export function BootFailed() {
  return (
    <CenteredScreen>
      <EmptyState
        icon={SyncIcon}
        title="Forgejo could not load"
        description="Check your connection, then reload."
        action={<Button variant="primary" type="button" onClick={() => { location.reload(); }}>Reload</Button>}
      />
    </CenteredScreen>
  );
}
