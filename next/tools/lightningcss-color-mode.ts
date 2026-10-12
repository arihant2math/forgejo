// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The app always resolves <html data-color-mode> to light or dark (splash.ts, theme.ts), so Primer's
// [data-color-mode=auto] rules, over a third of the inline theme CSS, can never match.

import type {CustomAtRules, Visitor} from 'lightningcss';

/** Lightning CSS visitor dropping selectors that need `data-color-mode="auto"`; it removes rules and media blocks left empty. */
export const dropAutoColorMode: Visitor<CustomAtRules> = {
  Selector(s) {
    return s.some((c) => c.type === 'attribute' && c.name === 'data-color-mode' && c.operation?.value === 'auto') ? [] : undefined;
  },
};
