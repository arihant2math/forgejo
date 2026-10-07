// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {HTMLAttributes, ReactNode, Ref} from 'react';
import {cx} from './cx.ts';

export interface ListRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'className'> {
  /** The row's role in its list: option (listbox), row (grid) or presentation (skeletons). */
  role: 'option' | 'row' | 'presentation';
  selected?: boolean;
  /** Fixed-width slot before the title (status icon, avatar, …). */
  leading?: ReactNode;
  /** Right-aligned metadata (labels, assignee, date, …). */
  trailing?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}

/**
 * One compact list row (issues, PRs, notifications). Fixed height and layout
 * containment, so virtualized lists can position rows without measuring.
 * Keyboard movement (roving tabindex, J/K) belongs to the list (F4).
 */
export function ListRow({role, selected, leading, trailing, children, ...rest}: ListRowProps) {
  return (
    <div
      role={role}
      data-selected={selected ? '' : undefined}
      aria-selected={role === 'presentation' ? undefined : Boolean(selected)}
      className={cx(
        'interactive flex h-row items-center gap-2 border-b border-border-subtle px-3 text-base text-fg contain-content',
        'hover:bg-hover data-selected:bg-selected',
      )}
      {...rest}
    >
      {leading && <span className="flex shrink-0 items-center gap-2 text-fg-muted">{leading}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && <span className="flex shrink-0 items-center gap-2 text-sm text-fg-muted">{trailing}</span>}
    </div>
  );
}
