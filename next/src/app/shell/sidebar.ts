// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// CSS reads <html> attributes so sidebar toggles need no React render; wide-screen collapse is stored for boot.

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

export function toggleSidebar(): void {
  const html = document.documentElement;
  if (narrow()) {
    if (drawerOpen()) closeDrawer(true);
    else {
      drawerOpener = document.querySelector<HTMLElement>('main button[aria-label="Show the sidebar"]') ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      html.dataset.drawer = 'open';
      requestAnimationFrame(() => {
        if (!drawerOpen()) return;
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
