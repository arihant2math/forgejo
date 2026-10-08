// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {cx} from './cx.ts';

/**
 * A placeholder bar. Static on purpose (no shimmer): skeletons are only shown
 * for the first frame, and an animation would cost paint time for nothing.
 * Give it a size with token utilities, e.g. className="h-3 w-40" (className is for size and
 * position only; the look comes from the props).
 */
const radii = {sm: 'rounded-sm', md: 'rounded-md', full: 'rounded-full'} as const;

export function Skeleton({round = 'sm', className}: {round?: keyof typeof radii; className?: string}) {
  return <span aria-hidden className={cx('block bg-skeleton', radii[round], className)}/>;
}

/** A paragraph's placeholder: `lines` full-width text bars, the last one shorter. Lay it out in the caller's column. */
export function SkeletonText({lines = 3}: {lines?: number}) {
  return <>{Array.from({length: lines}, (_, i) => <Skeleton key={i} className={i === lines - 1 ? 'h-3 w-2/3' : 'h-3 w-full'}/>)}</>;
}
