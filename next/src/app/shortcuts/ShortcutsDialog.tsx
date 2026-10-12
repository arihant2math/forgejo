// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Dialog, Heading, Text} from '@primer/react';
import {KeybindingHint} from '@primer/react/experimental';
import {runInAction} from 'mobx';
import {useState} from 'react';
import {useApp} from '../store.ts';
import {KEYMAP, SCOPE_LABELS, type Scope, type ShortcutId} from './keymap.ts';
import {shortcuts} from './index.ts';

export function ShortcutsDialog() {
  const {ui} = useApp();
  const [active] = useState(() => shortcuts.activeScopes());
  const [works] = useState(() => {
    const bound = shortcuts.bound();
    return (id: ShortcutId) => KEYMAP[id].scope === 'global' || ((bound.has(id) || 'local' in KEYMAP[id]) && !shortcuts.shadowed(id));
  });
  const byScope = new Map<Scope, ShortcutId[]>();
  for (const id of Object.keys(KEYMAP) as ShortcutId[]) {
    const scope = KEYMAP[id].scope;
    if (!KEYMAP[id].keys || (active.includes(scope) && !works(id))) continue;
    byScope.set(scope, [...byScope.get(scope) ?? [], id]);
  }
  const order = [...byScope.keys()].sort((a, b) => rank(active, a) - rank(active, b));
  const close = () => {
    runInAction(() => { ui.shortcutsOpen = false; });
  };
  return (
    <Dialog title="Keyboard shortcuts" width="large" onClose={close} footerButtons={[{content: 'Close', onClick: close}]}>
      <div className="flex flex-col gap-4">
        {order.map((scope) => (
          <section key={scope} aria-labelledby={`shortcuts-${scope}`} className="flex flex-col gap-1">
            <Heading as="h2" variant="small" id={`shortcuts-${scope}`}>
              {`${SCOPE_LABELS[scope]}${active.includes(scope) && scope !== 'global' ? ' · on this page' : ''}`}
            </Heading>
            <dl className="flex flex-col">
              {(byScope.get(scope) ?? []).map((id) => (
                <div key={id} className="flex items-center justify-between gap-4 py-1">
                  <Text as="dt">{KEYMAP[id].label}</Text>
                  <dd className="shrink-0"><KeybindingHint keys={KEYMAP[id].keys}/></dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function rank(active: Scope[], scope: Scope): number {
  const index = active.indexOf(scope);
  return index < 0 ? active.length : index;
}
