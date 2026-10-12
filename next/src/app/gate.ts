// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {NextConfig} from '../protocol/types.gen.ts';

/** Forgejo sign-in redirects preserve the sign-in page as a same-origin referrer. */
const CLASSIC_SIGN_IN_PAGES = new Set([
  '/user/login', '/user/two_factor', '/user/two_factor/scratch', '/user/webauthn', '/user/sign_up',
  '/user/link_account', '/user/link_account_signin', '/user/link_account_signup',
]);

/** Whether `referrer` is one of Forgejo's sign-in pages on this instance (same origin, below its sub-path). */
export function fromClassicSignIn(config: NextConfig, referrer: string, origin: string): boolean {
  if (!referrer) return false;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  const sub = config.app_sub_url;
  if (sub && !url.pathname.startsWith(`${sub}/`)) return false;
  const path = url.pathname.slice(sub.length).replace(/\/+$/, '');
  return CLASSIC_SIGN_IN_PAGES.has(path);
}

const HANDOFF = 'forgejo-next:classicHandoff';
/** Prevent hand-off loops when authorization does not complete. */
const HANDOFF_WINDOW = 2 * 60_000;

/** Claims a recent classic sign-in hand-off unless this tab started one within the cooldown. */
export function claimClassicHandoff(
  config: NextConfig, referrer: string, origin: string, now = Date.now(),
  storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage,
): boolean {
  if (!config.oauth || !fromClassicSignIn(config, referrer, origin)) return false;
  try {
    const raw = storage.getItem(HANDOFF);
    const last = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(last) && now - last >= 0 && now - last < HANDOFF_WINDOW) return false;
    storage.setItem(HANDOFF, String(now));
    return true;
  } catch {
    return false;
  }
}
