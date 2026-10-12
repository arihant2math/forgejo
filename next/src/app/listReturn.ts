// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Remember cursors per list address for this tab so keyboard navigation resumes on return.

const opened = new Map<string, number | string>();

export function rememberRow(path: string, id: number | string): void {
  opened.set(path, id);
  if (opened.size > 50) opened.delete(opened.keys().next().value ?? '');
}

export function rememberedRow(path: string): number | string | undefined {
  return opened.get(path);
}

/** Focuses without scrolling, but preserves focus in another control, field or overlay. */
export function focusList(el: HTMLElement | null): void {
  if (!el?.isConnected) return;
  const a = el.ownerDocument.activeElement;
  if (a && a !== el.ownerDocument.body && a !== el && !el.contains(a)) return;
  el.focus({preventScroll: true});
}
