// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type FocusEvent, type RefObject, useRef} from 'react';
import {useShortcut, useShortcutScope} from '../app/shortcuts/index.ts';

/** The link rows `useRowKeys` moves over: every `ListRow` with an href. */
const ROWS = 'a[data-list-row][href]';

function rowsOf(root: HTMLElement | null): HTMLAnchorElement[] {
  return [...(root?.querySelectorAll<HTMLAnchorElement>(ROWS) ?? [])];
}

/** The focused link row inside `root`, if any. */
export function focusedRow(root: HTMLElement | null): HTMLAnchorElement | undefined {
  const at = document.activeElement;
  return at instanceof HTMLAnchorElement && root?.contains(at) && at.matches(ROWS) ? at : undefined;
}

/** Moves focus by `delta` rows (the first row when none has focus) and marks it as the cursor. */
export function moveRow(root: HTMLElement | null, delta: number): void {
  const rows = rowsOf(root);
  if (!rows.length) return;
  const at = rows.findIndex((row) => row === document.activeElement);
  const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + delta))];
  for (const row of rows) row.removeAttribute('data-active');
  next?.setAttribute('data-active', '');
  next?.focus({preventScroll: true});
  next?.scrollIntoView({block: 'nearest'});
}

export interface RowKeysProps {
  ref: RefObject<HTMLDivElement | null>;
  'data-shortcuts': '';
  onBlur: (e: FocusEvent) => void;
}

/** Page-level J/K and Enter over the link rows of a non-virtualized list, without making them menu items.
 * Spread the result on the element that contains the rows. */
export function useRowKeys(): RowKeysProps {
  const root = useRef<HTMLDivElement>(null);
  useShortcutScope('list');
  useShortcut('list.next', () => { moveRow(root.current, 1); });
  useShortcut('list.prev', () => { moveRow(root.current, -1); });
  useShortcut('list.open', () => { focusedRow(root.current)?.click(); }, true, () => focusedRow(root.current) !== undefined);
  return {ref: root, 'data-shortcuts': '', onBlur: (e) => {
    if (e.target instanceof HTMLElement) e.target.removeAttribute('data-active');
  }};
}
