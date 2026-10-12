// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// CSS reads <html> attributes so sidebar toggles need no React render; wide-screen collapse is stored for boot.

import {readSplash, writeSplash} from '../splash.ts';

/** The default sidebar width in CSS px (= --sidebar-width in tokens.css). */
export const SIDEBAR_DEFAULT = 232;

/** Below this width the sidebar is a drawer (= --breakpoint-md). */
const NARROW = '(max-width: 767.98px)';

function narrow(): boolean {
  return typeof matchMedia === 'function' && matchMedia(NARROW).matches;
}

export function drawerOpen(): boolean {
  return document.documentElement.dataset.drawer === 'open';
}

const listeners = new Set<() => void>();

/** Subscribes to the drawer opening and closing (for useSyncExternalStore). */
export function onDrawerChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Where focus goes when the drawer's focus trap ends; null leaves it alone. */
export const drawerReturnFocus: {current: HTMLElement | null} = {current: null};

let drawerOpener: HTMLElement | null = null;

function setDrawer(open: boolean): void {
  if (open) document.documentElement.dataset.drawer = 'open';
  else delete document.documentElement.dataset.drawer;
  for (const listener of listeners) listener();
}

export function closeDrawer(restoreFocus = false): void {
  if (!drawerOpen()) return;
  drawerReturnFocus.current = restoreFocus && drawerOpener?.isConnected ? drawerOpener : null;
  drawerOpener = null;
  setDrawer(false);
}

export function toggleSidebar(): void {
  const html = document.documentElement;
  if (narrow()) {
    if (drawerOpen()) closeDrawer(true);
    else {
      drawerOpener = document.querySelector<HTMLElement>('main button[aria-label="Show the sidebar"]') ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      drawerReturnFocus.current = null;
      setDrawer(true);
    }
    return;
  }
  const hidden = !readSplash().sidebarHidden;
  writeSplash({sidebarHidden: hidden});
  if (hidden) html.dataset.sidebar = 'hidden';
  else delete html.dataset.sidebar;
}
