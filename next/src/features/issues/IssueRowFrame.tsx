// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {clsx} from 'clsx';
import type {ComponentPropsWithoutRef, ReactNode} from 'react';

/** Dense, navigable data rows: fixed height matches the list's virtualizer. */
export function IssueRowFrame({leading, trailing, children, active = false, selected = false, className, ...props}:
  Omit<ComponentPropsWithoutRef<'a'>, 'href'> & {href?: string | undefined; leading: ReactNode; trailing: ReactNode; active?: boolean; selected?: boolean}) {
  return <a {...props} aria-selected={props.role === 'option' ? selected : undefined}
    data-active={active ? '' : undefined} data-selected={selected ? '' : undefined}
    className={clsx('group @container relative row-cursor contain-content flex h-10 items-center gap-2 border-b border-muted px-3 text-sm text-default no-underline hover:bg-control-transparent-hover',
      selected && 'bg-accent-muted', className)}
    style={props.style}>
    <span className="flex shrink-0 items-center gap-2">{leading}</span>
    <span className="min-w-0 flex-1 truncate">{children}</span>
    <span className="flex shrink-0 items-center gap-2 text-muted">{trailing}</span>
  </a>;
}
