// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {CenteredScreen} from './LoggedOut.tsx';
import {SyncIcon} from '@primer/octicons-react';
import {Button} from '@primer/react';
import {Blankslate} from '@primer/react/experimental';

/** Shown when the boot route's chunk still fails after one reload. */
export function BootFailed() {
  return (
    <CenteredScreen>
      <Blankslate><Blankslate.Visual><SyncIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Forgejo could not load</Blankslate.Heading><Blankslate.Description>Check your connection, then reload.</Blankslate.Description>{<Button variant="primary" type="button" onClick={() => { location.reload(); }}>Reload</Button>}</Blankslate>
    </CenteredScreen>
  );
}
