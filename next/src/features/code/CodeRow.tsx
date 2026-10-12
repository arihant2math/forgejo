// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {HTMLAttributes, ReactNode} from 'react';
import {clsx} from 'clsx';

/** Dense, fixed-height data row. Keyboard navigation belongs to RowList. */
export function CodeRow({leading, trailing, active, selected, href, children, ...props}: Omit<HTMLAttributes<HTMLElement>, 'role'> & {
  role?: 'option' | 'presentation' | undefined;
  leading?: ReactNode; trailing?: ReactNode; active?: boolean; selected?: boolean;
  href?: string | undefined;
}) {
  const Tag = href === undefined ? 'div' : 'a';
  return <Tag {...(href === undefined ? {} : {href})} data-active={active ? '' : undefined}
    className={clsx('group relative flex h-row items-center gap-2 border-b border-muted px-4 text-base text-default contain-content hover:bg-control-transparent-hover',
      (active === true || selected === true) && 'bg-control-transparent-selected')}
    {...props}>
    {leading && <span className="flex shrink-0 items-center gap-2 text-muted">{leading}</span>}
    <span className={clsx('min-w-0 flex-1 truncate', href !== undefined && 'group-hover:text-accent group-hover:underline')}>{children}</span>
    {trailing && <span className="flex shrink-0 items-center gap-2 text-sm text-muted">{trailing}</span>}
  </Tag>;
}
