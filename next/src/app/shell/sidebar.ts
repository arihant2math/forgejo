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

let drawerOpener: HTMLElement | null = null;

export function closeDrawer(restoreFocus = false): void {
  const wasOpen = drawerOpen();
  delete document.documentElement.dataset.drawer;
  if (wasOpen && restoreFocus && drawerOpener?.isConnected) drawerOpener.focus({preventScroll: true});
  drawerOpener = null;
}

/** Shows or hides the sidebar (the drawer on a narrow screen; collapsed, remembered, on a wide one). */
export function toggleSidebar(): void {
  const html = document.documentElement;
  if (narrow()) {
    if (drawerOpen()) closeDrawer(true);
    else {
      drawerOpener = document.querySelector<HTMLElement>('main button[aria-label="Show the sidebar"]') ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      html.dataset.drawer = 'open';
      // The drawer takes the focus (its first link), so the keyboard is where the eyes are.
      requestAnimationFrame(() => {
        if (!drawerOpen()) return;
        document.querySelector<HTMLElement>('aside[aria-label="Sidebar"] a, aside[aria-label="Sidebar"] button')?.focus();
      });
    }
    return;
  }
  const hidden = !readSplash().sidebarHidden;
  // Toggled with one of its buttons (the sidebar's Hide, the header's Show): the focus goes to the one that replaces
  // it, not to <body> as the clicked one disappears (QA).
  const byButton = document.activeElement instanceof Element && document.activeElement.closest('[data-sidebar-toggle]') !== null;
  writeSplash({sidebarHidden: hidden});
  if (hidden) html.dataset.sidebar = 'hidden';
  else delete html.dataset.sidebar;
  if (byButton) {
    requestAnimationFrame(() => {
      for (const b of document.querySelectorAll<HTMLElement>('[data-sidebar-toggle]')) {
        if (b.checkVisibility()) {
          b.focus({preventScroll: true});
          return;
        }
      }
    });
  }
}
