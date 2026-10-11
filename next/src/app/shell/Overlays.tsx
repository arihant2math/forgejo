// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Dialogs the shell opens rarely (their own chunk).

import {runInAction} from 'mobx';
import {useState} from 'react';
import {DialogClose, SectionHeading, Shortcut} from '../../ui/index.ts';
import {performSignOut} from '../session.ts';
import {KEYMAP, SCOPE_LABELS, type Scope, shortcutHint, type ShortcutId, shortcuts} from '../shortcuts/index.ts';
import {useApp} from '../store.ts';
import {Button, Dialog} from '@primer/react';

/** Every keyboard shortcut, by scope: the ones that work on this page first (marked), then the others. */
export function ShortcutsDialog() {
  const {ui} = useApp();
  const [active] = useState(() => shortcuts.activeScopes());
  // On this page's scopes, only what works here: bound now, and not overridden by a key of an inner scope (on a
  // board L is the next column, not labels). Other pages' scopes are listed in full.
  const [works] = useState(() => {
    const bound = shortcuts.bound();
    return (id: ShortcutId) => KEYMAP[id].scope === 'global' || ((bound.has(id) || 'local' in KEYMAP[id]) && !shortcuts.shadowed(id));
  });
  const byScope = new Map<Scope, ShortcutId[]>();
  for (const id of Object.keys(KEYMAP) as ShortcutId[]) {
    const scope = KEYMAP[id].scope;
    // Commands without keys are the palette's, not the help's.
    if (!KEYMAP[id].keys || (active.includes(scope) && !works(id))) continue;
    byScope.set(scope, [...byScope.get(scope) ?? [], id]);
  }
  const order = [...byScope.keys()].sort((a, b) => rank(active, a) - rank(active, b));
  const close = () => {
    runInAction(() => {
      ui.shortcutsOpen = false;
    });
  };
  return (
    <Dialog title="Keyboard shortcuts" width="large" onClose={() => { const open = false; if (!open) close(); }} renderFooter={() => <Dialog.Footer>{<DialogClose asChild><Button type="button">Close</Button></DialogClose>}</Dialog.Footer>}>
      <div className="flex flex-col gap-3">
        {order.map((scope) => (
          <section key={scope} className="flex flex-col gap-1">
            <SectionHeading>{`${SCOPE_LABELS[scope]}${active.includes(scope) && scope !== 'global' ? ' · on this page' : ''}`}</SectionHeading>
            <dl className="flex flex-col">
              {(byScope.get(scope) ?? []).map((id) => (
                <div key={id} className="flex min-h-control items-center justify-between gap-4 py-1 text-base">
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
    <Dialog title="Sign out with unsynced changes?" subtitle={`${String(pending)} ${pending === 1 ? 'change has' : 'changes have'} not reached Forgejo yet. Signing out deletes ${pending === 1 ? 'it' : 'them'} from this device.`} width="medium" onClose={() => { const open = false; if (!open) cancel(); }} renderFooter={() => <Dialog.Footer>{<>
          <Button type="button" onClick={cancel}>Cancel</Button>
          <Button variant="danger" type="button" disabled={busy} onClick={() => {
            setBusy(true);
            void performSignOut(app);
          }}>Sign out anyway</Button>
        </>}</Dialog.Footer>}></Dialog>
  );
}
