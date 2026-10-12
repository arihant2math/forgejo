// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {count, noun} from '../words.ts';
import {runInAction} from 'mobx';
import {useState} from 'react';
import {ConfirmationDialog} from '@primer/react';
import {performSignOut} from '../session.ts';
import {useApp} from '../store.ts';

export {ShortcutsDialog} from '../shortcuts/ShortcutsDialog.tsx';

export function SignOutDialog({pending}: {pending: number}) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const cancel = () => {
    runInAction(() => { app.ui.signOut = undefined; });
  };
  return (
    <ConfirmationDialog title="Sign out with unsynced changes?" confirmButtonContent="Sign out anyway" confirmButtonType="danger" confirmButtonLoading={busy}
      onClose={(gesture) => {
        if (gesture !== 'confirm') cancel();
        else if (!busy) {
          setBusy(true);
          void performSignOut(app);
        }
      }}>
      {`${count(pending, 'change has', 'changes have')} not reached Forgejo yet. Signing out deletes ${noun(pending, 'it', 'them')} from this device.`}
    </ConfirmationDialog>
  );
}
