// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The URL of a classic page (ClassicLink.tsx renders the links; this module
// has no UI, so actions and menus can use it without the primitives).

import {sitePath} from './config.ts';
import {isCanonical} from './paths.ts';
import type {App} from './store.ts';

/** The URL of a classic page (`path`: a site path, with or without a query). */
export function classicHref(app: App, path: string): string {
  const q = path.indexOf('?');
  const bare = q < 0 ? path : path.slice(0, q);
  const search = new URLSearchParams(q < 0 ? '' : path.slice(q + 1));
  if (isCanonical(bare)) search.set('ui', 'classic');
  const s = search.toString();
  return sitePath(app.config, `${bare}${s ? `?${s}` : ''}`);
}

/** The tooltip and accessible hint of every classic link. */
export const CLASSIC_HINT = 'Opens in the classic Forgejo UI';
