// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Coming back to a list (Esc on an issue, Back, a breadcrumb, Undo): the cursor is on the row the user left from
// and the list has the focus, so J › Enter › Esc › Enter goes on without a click (Linear). Each list remembers the
// row it opened last, per address, for the tab's life.

const opened = new Map<string, number | string>();

/** The list at `path` opened this row (an issue, a notification, a file). */
export function rememberRow(path: string, id: number | string): void {
  opened.set(path, id);
  // A long session visits many lists: the oldest are forgotten.
  if (opened.size > 50) opened.delete(opened.keys().next().value ?? '');
}

/** The row the list at `path` opened last, if any. */
export function rememberedRow(path: string): number | string | undefined {
  return opened.get(path);
}

/**
 * Gives a list the focus (without scrolling) unless the user is somewhere else already: a field, a dialog, a menu
 * or another control keeps it.
 */
export function focusList(el: HTMLElement | null): void {
  if (!el?.isConnected) return;
  const a = el.ownerDocument.activeElement;
  if (a && a !== el.ownerDocument.body && a !== el && !el.contains(a)) return;
  el.focus({preventScroll: true});
}
