// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';

/** Stays mounted even when empty, so assistive technology announces new Banners. */
export function NoticeViewport({children}: {children: ReactNode}) {
  return <div aria-label="Notifications" aria-live="polite" aria-relevant="additions text" className="pointer-events-none fixed z-popover inset-x-4 bottom-4 flex flex-col gap-2 md:left-auto md:w-80">{children}</div>;
}
