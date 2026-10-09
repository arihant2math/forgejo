// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Runs `fn` after the next frame is painted: what a click shows at once (a menu closing, a checkmark) paints
 * first, and the heavier change it asks for (a long list regrouped) follows in a task of its own, instead of
 * holding that first frame back.
 */
export function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => {
    setTimeout(fn, 0);
  });
}
