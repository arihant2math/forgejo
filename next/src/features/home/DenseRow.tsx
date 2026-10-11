// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {HTMLAttributes, ReactNode} from 'react';
import {clsx} from 'clsx';

interface DenseRowProps extends HTMLAttributes<HTMLElement> {
  href?: string | undefined;
  selected?: boolean | undefined;
  active?: boolean | undefined;
  leading?: ReactNode;
  trailing?: ReactNode;
}

/** A contained, fixed-height data row for dashboard, activity, notifications and search.
 * Keyboard navigation and selection belong to the containing feature's listbox. */
export function DenseRow({href, selected, active, leading, trailing, children, role, ...rest}: DenseRowProps) {
  const Tag = href === undefined ? 'div' : 'a';
  return <Tag {...rest} href={href} role={role} data-home-row=""
    data-active={active ? '' : undefined} data-selected={selected ? '' : undefined}
    aria-selected={role === 'option' ? Boolean(selected) : undefined}
    className={clsx('relative flex h-8 min-w-0 items-center gap-2 border-b border-muted px-3 text-default contain-content hover:bg-control-transparent-hover focus-visible:outline-focus',
      'data-active:not-data-selected:bg-control-transparent-selected data-selected:bg-accent-muted')}>
    {leading && <span className="flex shrink-0 items-center gap-2 text-muted">{leading}</span>}
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {trailing && <span className="flex shrink-0 items-center gap-2 text-sm text-muted">{trailing}</span>}
  </Tag>;
}
