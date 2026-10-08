// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Its own module: the shell renders it from the start (the boot route), the
// notices themselves load with their chunk.

import type {ReactNode} from 'react';

/**
 * Where notices stack (bottom right, above the page and dialogs). Render it once, from the start (a
 * live region must exist before its content arrives to be announced), around the notices.
 */
export function NoticeViewport({children}: {children?: ReactNode}) {
  return (
    <section aria-label="Notices" aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-popover flex w-full max-w-xs flex-col items-stretch gap-2">
      {children}
    </section>
  );
}
