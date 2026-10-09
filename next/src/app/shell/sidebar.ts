// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Showing and hiding the sidebar: on a wide screen it collapses (remembered
// in the splash, applied before the first paint), on a narrow one it is a
// drawer over the page. Both are attributes on <html> read by CSS variants
// (sidebar-hidden, drawer-open): toggling re-renders nothing.

import {readSplash, writeSplash} from '../splash.ts';

/** Below this width the sidebar is a drawer (= --breakpoint-md). */
const NARROW = '(max-width: 767.98px)';

function narrow(): boolean {
  return typeof matchMedia === 'function' && matchMedia(NARROW).matches;
}

export function drawerOpen(): boolean {
  return document.documentElement.dataset.drawer === 'open';
}

export function closeDrawer(): void {
  delete document.documentElement.dataset.drawer;
}

/** Shows or hides the sidebar (the drawer on a narrow screen; collapsed, remembered, on a wide one). */
export function toggleSidebar(): void {
  const html = document.documentElement;
  if (narrow()) {
    if (drawerOpen()) closeDrawer();
    else {
      html.dataset.drawer = 'open';
      // The drawer takes the focus (its first link), so the keyboard is where the eyes are.
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('aside[aria-label="Sidebar"] a, aside[aria-label="Sidebar"] button')?.focus();
      });
    }
    return;
  }
  const hidden = !readSplash().sidebarHidden;
  writeSplash({sidebarHidden: hidden});
  if (hidden) html.dataset.sidebar = 'hidden';
  else delete html.dataset.sidebar;
}
