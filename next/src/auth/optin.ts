// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {uiPath} from '../app/config.ts';
import {type NextConfig, NextUICookie, NextUICookieValue} from '../protocol/types.gen.ts';

export function optedIn(): boolean {
  return document.cookie.split(';').some((c) => c.trim() === `${NextUICookie}=${NextUICookieValue}`);
}

/** Sets the server cookie so canonical URLs reload into the Next UI. */
export async function optIn(config: NextConfig, fetchFn: typeof fetch = fetch.bind(globalThis)): Promise<void> {
  if (optedIn()) return;
  try {
    await fetchFn(uiPath(config, 'opt-in'), {method: 'POST', redirect: 'manual', credentials: 'same-origin', cache: 'no-store'});
  } catch {
    // Offline: the next boot tries again.
  }
}
