// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Step back over OAuth login/consent pages, then replace the initiating page with the target.
// This keeps Back from returning to consent.

/** The history length when signing in started (this tab; auth/signin.ts writes it). */
export const SIGNIN_FROM = 'forgejo-next:signinFrom';

const AFTER = 'forgejo-next:afterSignIn';

/** The callback: leaves for `returnTo`, stepping back over the sign-in pages when it can. */
export function leaveCallback(returnTo: string): void {
  let from = NaN;
  try {
    from = Number(sessionStorage.getItem(SIGNIN_FROM));
    sessionStorage.removeItem(SIGNIN_FROM);
  } catch {
    // Storage blocked: a plain replace.
  }
  const back = history.length - from;
  if (Number.isSafeInteger(from) && from > 0 && back > 0 && back < 20) {
    try {
      sessionStorage.setItem(AFTER, returnTo);
      history.go(-back);
      // Fall back if history.go cannot reach the initiating entry.
      setTimeout(() => {
        location.replace(returnTo);
      }, 1500);
      return;
    } catch {
      // Use direct navigation when stepping back fails.
    }
  }
  location.replace(returnTo);
}

function takeAfter(): string | undefined {
  try {
    const to = sessionStorage.getItem(AFTER) ?? undefined;
    sessionStorage.removeItem(AFTER);
    return to?.startsWith('/') && !to.startsWith('//') ? to : undefined;
  } catch {
    return undefined;
  }
}

/** At boot (before the router reads the URL): a page reached by the callback's step back becomes the target. */
export function resumeAfterSignIn(): void {
  const to = takeAfter();
  if (to) history.replaceState(null, '', to);
  // A bfcache restore bypasses boot; reload the target on pageshow.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    const next = takeAfter();
    if (next) location.replace(next);
  });
}
