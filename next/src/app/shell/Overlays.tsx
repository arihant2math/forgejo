// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {runInAction} from 'mobx';
import {useState} from 'react';
import {Dialog} from '@primer/react';
import {performSignOut} from '../session.ts';
import {useApp} from '../store.ts';

// Shortcut content is owned by the keyboard area, still loaded with the shell's overlay chunk.
export {ShortcutsDialog} from '../shortcuts/ShortcutsDialog.tsx';

/** The sign-out warning: queued changes are deleted with the device's local data. */
export function SignOutDialog({pending}: {pending: number}) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const cancel = () => {
    runInAction(() => { app.ui.signOut = undefined; });
  };
  return (
    <Dialog title="Sign out with unsynced changes?"
      subtitle={`${String(pending)} ${pending === 1 ? 'change has' : 'changes have'} not reached Forgejo yet. Signing out deletes ${pending === 1 ? 'it' : 'them'} from this device.`}
      width="medium" onClose={cancel} footerButtons={[
        {content: 'Cancel', onClick: cancel},
        {content: 'Sign out anyway', buttonType: 'danger', disabled: busy, onClick: () => {
          setBusy(true);
          void performSignOut(app);
        }},
      ]}/>
  );
}
