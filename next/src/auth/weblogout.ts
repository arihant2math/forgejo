// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Ending Forgejo's own web session when signing out (the classic login cookie): a "Sign in" afterwards must ask
// for the password again. Offline the request fails; it is remembered on this device and made as soon as the
// browser is online again (at the next boot, on the `online` event, and before any sign-in starts), so a signed-out
// device on a shared machine never keeps a live Forgejo session (QA round 2).

const KEY = 'forgejo-next:webLogout';

/** The logout URL still to be called, if a sign-out could not end the web session. */
export function pendingWebLogout(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(url: string | undefined): void {
  try {
    if (url) localStorage.setItem(KEY, url);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing to resume later.
  }
}

/** Ends the web session (Forgejo's classic sign-out: a same-origin POST). Remembered for later when it fails. */
export async function endWebSession(url: string): Promise<void> {
  remember(url);
  await fetch(url, {method: 'POST', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(5000)});
  remember(undefined);
}

/** Finishes a remembered logout; true when there is none left. */
export async function finishWebLogout(): Promise<boolean> {
  const url = pendingWebLogout();
  if (!url) return true;
  try {
    await endWebSession(url);
    return true;
  } catch {
    return false;
  }
}

let listening = false;

/** At boot: finishes a remembered logout now, or when the browser comes back online. */
export function resumeWebLogout(): void {
  if (!pendingWebLogout()) return;
  void finishWebLogout();
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('online', () => {
    void finishWebLogout();
  });
}
