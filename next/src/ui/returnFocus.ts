// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useRef} from 'react';

/**
 * Radix returns focus to a dialog's trigger, but a dialog opened from the
 * keyboard (⌘K, ?) has none: focus would fall to <body>. These handlers
 * remember what had focus when the dialog opened and put it back on close.
 */
export function useReturnFocus(): {onOpenAutoFocus: () => void; onCloseAutoFocus: (e: Event) => void} {
  const before = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      const el = document.activeElement;
      before.current = el instanceof HTMLElement && el !== document.body ? el : null;
    },
    onCloseAutoFocus: (e) => {
      const el = before.current;
      before.current = null;
      if (el?.isConnected) {
        e.preventDefault();
        el.focus({preventScroll: true});
      }
    },
  };
}
