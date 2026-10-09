// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';

/**
 * A bordered block on the page (a review comment, a composer, the merge box):
 * the one card look. `label` names it as a region.
 */
export function Card({children, label, as: Tag = 'div'}: {children: ReactNode; label?: string | undefined; as?: 'div' | 'article' | 'section'}) {
  return <Tag aria-label={label} className="flex max-w-lg flex-col gap-2 rounded-md border border-border bg-surface p-3">{children}</Tag>;
}
