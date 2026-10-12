// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {SkeletonAvatar, SkeletonBox} from '@primer/react/experimental';

/** A list's rows while it loads: a leading avatar or icon (or none), then one or two lines; screen readers hear Loading. */
export function ListSkeleton({rows = 3, lines = 2, leading = 'avatar'}: {rows?: number; lines?: 1 | 2; leading?: 'avatar' | 'icon' | 'none'}) {
  return (
    <div className="flex flex-col" aria-busy>
      <span role="status" className="sr-only">Loading…</span>
      {Array.from({length: rows}, (_, i) => (
        <div key={i} aria-hidden className={lines === 1 ? 'flex items-center gap-2 px-4 py-2' : 'flex items-center gap-2 border-b border-muted px-4 py-3 last:border-b-0'}>
          {leading === 'avatar' ? <SkeletonAvatar size={20}/> : leading === 'icon' && <SkeletonBox className="size-4"/>}
          {lines === 1 ? <SkeletonBox className="h-3 w-48"/> : <span className="flex flex-1 flex-col gap-1"><SkeletonBox className="h-3 w-40"/><SkeletonBox className="h-3 w-24"/></span>}
        </div>
      ))}
    </div>
  );
}
