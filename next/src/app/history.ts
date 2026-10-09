// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Leaving the sign-in pages out of the history. Signing in goes through
// Forgejo's login and consent pages, then the callback; landing in the app
// from there, Back would show the consent page again. So the callback steps
// back to the page the sign-in started from (history.go) and that page,
// loading again (or restored from the back/forward cache), goes on to the
// page the user wanted (replace: no new entry).

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
      // Nothing happened (the entries are gone): go there directly.
      setTimeout(() => {
        location.replace(returnTo);
      }, 1500);
      return;
    } catch {
      // Fall through.
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
  // Restored from the back/forward cache (the logged-out page as it was): load the target instead.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    const next = takeAfter();
    if (next) location.replace(next);
  });
}
