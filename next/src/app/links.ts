// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useRouter} from '@tanstack/react-router';
import type {MouseEvent} from 'react';
import {sitePath} from './config.ts';
import type {App} from './store.ts';

/** True for unhandled, unmodified primary clicks; other clicks belong to the browser. */
export function plainClick(e: MouseEvent): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

/** The href of a router path (site path, with search/hash) for an anchor. */
export function hrefOf(app: App, path: string): string {
  return sitePath(app.config, path);
}

/** Returns true when a plain click navigates in place; leaves other clicks to the browser. */
export function useLinkClick(): (e: MouseEvent, href: string) => boolean {
  const router = useRouter();
  return (e, href) => {
    if (!plainClick(e)) return false;
    e.preventDefault();
    void router.navigate({href});
    return true;
  };
}
