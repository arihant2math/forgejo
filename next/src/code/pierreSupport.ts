// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pierre 1.5 writes generated HTML (including its SVG sprite) to innerHTML and
 * offers no TrustedHTML hook. In Trusted Types browsers the SPA's CSP forbids
 * those sinks. Use our text-node renderer there; do not weaken the app policy,
 * install a default policy, or patch DOM prototypes to accommodate the library.
 * This gate can go away when Pierre accepts a scoped TrustedHTML factory.
 */
export function pierreHTMLSupported(): boolean {
  return !('trustedTypes' in globalThis);
}
