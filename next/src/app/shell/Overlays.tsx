// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Dialogs the shell opens rarely (their own chunk).

import {runInAction} from 'mobx';
import {useState} from 'react';
import {Button, Dialog, DialogClose, SectionHeading, Shortcut} from '../../ui/index.ts';
import {performSignOut} from '../session.ts';
import {KEYMAP, SCOPE_LABELS, type Scope, shortcutHint, type ShortcutId, shortcuts} from '../shortcuts/index.ts';
import {useApp} from '../store.ts';

/** Every keyboard shortcut, by scope: the ones that work on this page first (marked), then the others. */
export function ShortcutsDialog() {
  const {ui} = useApp();
  const [active] = useState(() => shortcuts.activeScopes());
  const byScope = new Map<Scope, ShortcutId[]>();
  for (const id of Object.keys(KEYMAP) as ShortcutId[]) {
    const scope = KEYMAP[id].scope;
    byScope.set(scope, [...byScope.get(scope) ?? [], id]);
  }
  const order = [...byScope.keys()].sort((a, b) => rank(active, a) - rank(active, b));
  const close = () => {
    runInAction(() => {
      ui.shortcutsOpen = false;
    });
  };
  return (
    <Dialog open title="Keyboard shortcuts" size="sm" initialFocus="dialog" onOpenChange={(open) => {
      if (!open) close();
    }} footer={<DialogClose asChild><Button>Close</Button></DialogClose>}>
      <div className="flex max-h-dialog-body flex-col gap-3 overflow-y-auto">
        {order.map((scope) => (
          <section key={scope} className="flex flex-col gap-1">
            <SectionHeading>{`${SCOPE_LABELS[scope]}${active.includes(scope) && scope !== 'global' ? ' · on this page' : ''}`}</SectionHeading>
            <dl className="flex flex-col">
              {(byScope.get(scope) ?? []).map((id) => (
                <div key={id} className="flex h-control items-center justify-between gap-4 text-base">
                  <dt className="text-fg">{KEYMAP[id].label}</dt>
                  <dd><Shortcut keys={shortcutHint(id)}/></dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

/** Active scopes first (innermost first), then the rest in the keymap's order. */
function rank(active: Scope[], scope: Scope): number {
  const i = active.indexOf(scope);
  return i < 0 ? active.length : i;
}

/** The sign-out warning: intents that have not synced are deleted with the local data. */
export function SignOutDialog({pending}: {pending: number}) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const cancel = () => {
    runInAction(() => {
      app.ui.signOut = undefined;
    });
  };
  return (
    <Dialog
      open
      title="Sign out with unsynced changes?"
      description={`${String(pending)} ${pending === 1 ? 'change has' : 'changes have'} not reached Forgejo yet. Signing out deletes ${pending === 1 ? 'it' : 'them'} from this device.`}
      size="sm"
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => {
            setBusy(true);
            void performSignOut(app);
          }}>Sign out anyway</Button>
        </>
      }
    />
  );
}
