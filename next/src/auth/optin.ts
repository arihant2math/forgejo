// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The opt-in cookie (B8): with it, Forgejo serves this UI on the canonical
// URLs it supports (spaRoutes), so a reload stays in the app.

import {uiPath} from '../app/config.ts';
import {type NextConfig, NextUICookie, NextUICookieValue} from '../protocol/types.gen.ts';

/** Whether this browser has the opt-in cookie (canonical URLs serve the Next UI). */
export function optedIn(): boolean {
  return document.cookie.split(';').some((c) => c.trim() === `${NextUICookie}=${NextUICookieValue}`);
}

/** Sets the opt-in cookie through the server (B8 `/-/next/opt-in`), so canonical URLs reload into this UI. */
export async function optIn(config: NextConfig, fetchFn: typeof fetch = fetch.bind(globalThis)): Promise<void> {
  if (optedIn()) return;
  try {
    await fetchFn(uiPath(config, 'opt-in'), {method: 'POST', redirect: 'manual', credentials: 'same-origin', cache: 'no-store'});
  } catch {
    // Offline: the next boot tries again.
  }
}
