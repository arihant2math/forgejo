// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Pierre uses innerHTML without a TrustedHTML hook. The CSP forbids those sinks
 * in Trusted Types browsers, so use the text-node renderer without weakening policy.
 */
export function pierreHTMLSupported(): boolean {
  return !('trustedTypes' in globalThis);
}
