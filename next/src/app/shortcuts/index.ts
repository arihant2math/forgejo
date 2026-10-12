// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useEffect, useLayoutEffect, useRef} from 'react';
import {type Scope, shortcutHint, type ShortcutId} from './keymap.ts';
import {ShortcutRegistry} from './registry.ts';

export {formatKeys, KEYMAP, SCOPE_LABELS, shortcutHint, type Scope, type ShortcutId} from './keymap.ts';

export const shortcuts = new ShortcutRegistry();

/** Omits the hint when a deeper scope shadows the shortcut. */
export function activeHint(id: ShortcutId): string | undefined {
  return shortcuts.shadowed(id) ? undefined : shortcutHint(id);
}

/** Mount-scoped binding calls the latest run without rebinding; when is checked on keypress and by the palette. */
export function useShortcut(id: ShortcutId, run: () => void, enabled = true, when?: () => boolean): void {
  const ref = useRef(run);
  const whenRef = useRef(when);
  useLayoutEffect(() => {
    ref.current = run;
    whenRef.current = when;
  });
  const conditional = when !== undefined;
  useEffect(() => {
    if (!enabled) return undefined;
    return shortcuts.bind(id, () => {
      ref.current();
    }, conditional ? () => whenRef.current?.() ?? true : undefined);
  }, [id, enabled, conditional]);
}

/** Activates a scope's shortcuts while the component is mounted. */
export function useShortcutScope(scope: Scope): void {
  useEffect(() => shortcuts.pushScope(scope), [scope]);
}
