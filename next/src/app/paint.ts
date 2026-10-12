// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Defers heavy work until after the next paint so immediate feedback is not delayed. */
export function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => {
    setTimeout(fn, 0);
  });
}
