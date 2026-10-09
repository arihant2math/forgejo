// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The app's shortcut registry and its React hooks.
//
//   useShortcut('go.inbox', () => navigate({to: '/notifications'}));
//   useShortcutScope('list');                      // J/K/X apply while mounted
//   <Button shortcut={shortcutHint('create')}>…    // hints come from the keymap

import {useEffect, useLayoutEffect, useRef} from 'react';
import {type Scope, shortcutHint, type ShortcutId} from './keymap.ts';
import {ShortcutRegistry} from './registry.ts';

export {formatKeys, KEYMAP, SCOPE_LABELS, shortcutHint, type Scope, type ShortcutId} from './keymap.ts';

/** The app's registry (attached to the window by the shell). */
export const shortcuts = new ShortcutRegistry();

/** A shortcut's hint, unless its keys do something else on this page now (menus and the palette, read when they open). */
export function activeHint(id: ShortcutId): string | undefined {
  return shortcuts.shadowed(id) ? undefined : shortcutHint(id);
}

/**
 * Binds `run` to a shortcut while the component is mounted (and `enabled`).
 * The latest `run` is called, without re-binding on every render.
 */
export function useShortcut(id: ShortcutId, run: () => void, enabled = true): void {
  const ref = useRef(run);
  useLayoutEffect(() => {
    ref.current = run;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    return shortcuts.bind(id, () => {
      ref.current();
    });
  }, [id, enabled]);
}

/** Activates a scope's shortcuts while the component is mounted. */
export function useShortcutScope(scope: Scope): void {
  useEffect(() => shortcuts.pushScope(scope), [scope]);
}
