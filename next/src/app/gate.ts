// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The signed-out gate's hand-off: whether this page was opened straight after
// signing in with Forgejo's own (classic) forms (pure, except for the tab's
// marker). Which address may be offered as a public classic page is paths.ts
// publicPageRepo (reserved first segments such as `/user/settings` are never a
// repository there).

import type {NextConfig} from '../protocol/types.gen.ts';

/**
 * Forgejo's own sign-in pages (site paths): a successful sign-in there sends the browser on to `/` or to the
 * page it came from, with that page as the referrer (Forgejo's documents say `referrer: same-origin`).
 */
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
/** A hand-off started this recently in this tab is not started again (no loop when it does not complete). */
const HANDOFF_WINDOW = 2 * 60_000;

/**
 * Claims the automatic hand-off from a classic sign-in to the app's own (OAuth) sign-in, once per tab: true
 * when this page was opened right after a classic sign-in and no hand-off was started in this tab lately.
 */
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
