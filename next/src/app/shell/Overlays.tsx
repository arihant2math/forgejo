// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {count, noun} from '../words.ts';
import {runInAction} from 'mobx';
import {useState} from 'react';
import {Dialog} from '@primer/react';
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
    <Dialog title="Sign out with unsynced changes?"
      subtitle={`${count(pending, 'change has', 'changes have')} not reached Forgejo yet. Signing out deletes ${noun(pending, 'it', 'them')} from this device.`}
      width="medium" onClose={cancel} footerButtons={[
        {content: 'Cancel', onClick: cancel},
        {content: 'Sign out anyway', buttonType: 'danger', disabled: busy, onClick: () => {
          setBusy(true);
          void performSignOut(app);
        }},
      ]}/>
  );
}
