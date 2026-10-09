// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Rows that are links (ListRow href): the anchor gives the browser's own
// middle-click, ⌘/Ctrl-click, "open in a new tab" and "copy link"; a plain
// click navigates in place (the router, no reload).

import {useRouter} from '@tanstack/react-router';
import type {MouseEvent} from 'react';
import {sitePath} from './config.ts';
import type {App} from './store.ts';

/** Whether a click is a plain primary click (not one the browser should handle: new tab, window, download). */
export function plainClick(e: MouseEvent): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** The href of a router path (site path, with search/hash) for an anchor. */
export function hrefOf(app: App, path: string): string {
  return sitePath(app.config, path);
}

/**
 * A handler for a link row's click: a plain click navigates to `href` (the anchor's, from hrefOf) in place
 * and returns true; any other click is left to the browser.
 */
export function useLinkClick(): (e: MouseEvent, href: string) => boolean {
  const router = useRouter();
  return (e, href) => {
    if (!plainClick(e)) return false;
    e.preventDefault();
    void router.navigate({href});
    return true;
  };
}
