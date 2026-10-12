// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {afterEach, expect, test, vi} from 'vitest';
import {closeDrawer, drawerOpen, onDrawerChange, toggleSidebar} from './sidebar.ts';

/** A controllable viewport: `resize(narrow)` fires `change` on every query list like a browser would. */
function viewport(initiallyNarrow: boolean) {
  let narrow = initiallyNarrow;
  const handlers = new Set<(e: MediaQueryListEvent) => void>();
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    media: query,
    get matches() { return narrow; },
    addEventListener: (_: string, h: (e: MediaQueryListEvent) => void) => { handlers.add(h); },
    removeEventListener: (_: string, h: (e: MediaQueryListEvent) => void) => { handlers.delete(h); },
  }) as unknown as MediaQueryList);
  return {
    handlers,
    resize(next: boolean) {
      narrow = next;
      for (const h of [...handlers]) h({matches: next} as MediaQueryListEvent);
    },
  };
}

afterEach(() => {
  closeDrawer();
  vi.restoreAllMocks();
});

test('widening the viewport past the breakpoint closes an open drawer', () => {
  const vp = viewport(true);
  const changes = vi.fn();
  const off = onDrawerChange(changes);
  toggleSidebar();
  expect(drawerOpen()).toBe(true);
  expect(vp.handlers.size).toBe(1);
  vp.resize(false);
  expect(drawerOpen()).toBe(false);
  expect(document.documentElement.dataset.drawer).toBeUndefined();
  expect(changes).toHaveBeenCalledTimes(2);
  // The listener lives only while the drawer is open.
  expect(vp.handlers.size).toBe(0);
  off();
});

test('staying narrow keeps the drawer open, and closing it stops watching the breakpoint', () => {
  const vp = viewport(true);
  toggleSidebar();
  vp.resize(true);
  expect(drawerOpen()).toBe(true);
  toggleSidebar();
  expect(drawerOpen()).toBe(false);
  expect(vp.handlers.size).toBe(0);
});
