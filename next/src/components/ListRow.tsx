// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {HTMLAttributes, ReactNode, Ref} from 'react';
import {createLink} from '@tanstack/react-router';
import {clsx} from 'clsx';

export interface ListRowProps extends Omit<HTMLAttributes<HTMLElement>, 'className' | 'style'> {
  /** A link row when set, a plain row otherwise. */
  href?: string | undefined;
  /** `compact`: the fixed code-row height; `normal`: a line plus padding. */
  density?: 'compact' | 'normal' | undefined;
  /** Part of a multi-selection. */
  selected?: boolean | undefined;
  /** Under the keyboard cursor. */
  active?: boolean | undefined;
  leading?: ReactNode;
  trailing?: ReactNode;
  ref?: Ref<HTMLElement> | undefined;
}

/** A normal row: 20px line, 8px padding on each side and its 1px separator. Keep virtual lists in sync. */
export const NORMAL_ROW_HEIGHT = 37;

/** GitHub's Box-row. Keyboard movement belongs to the containing list (a listbox or `useRowKeys`).
 * `no-underline` keeps Primer's link hover underline off the whole row, so only the title is underlined. */
export function ListRow({href, density = 'normal', selected, active, leading, trailing, children, role, ref, ...rest}: ListRowProps) {
  const Tag = href === undefined ? 'div' : 'a';
  return (
    <Tag aria-selected={role === 'option' ? Boolean(selected) : undefined} {...rest} ref={ref as Ref<HTMLAnchorElement & HTMLDivElement>}
      href={href} role={role} data-list-row="" data-active={active ? '' : undefined} data-selected={selected ? '' : undefined}
      className={clsx('group relative flex min-w-0 items-center gap-2 border-b border-muted px-4 text-base text-default no-underline contain-content hover:bg-control-transparent-hover focus-visible:outline-focus',
        'data-active:not-data-selected:bg-control-transparent-selected data-selected:bg-accent-muted', density === 'compact' ? 'h-row' : 'py-2')}>
      {leading && <span className="flex shrink-0 items-center gap-2 text-muted">{leading}</span>}
      <span className={clsx('min-w-0 flex-1 truncate', density === 'normal' && 'min-h-line', href !== undefined && 'group-hover:text-accent group-hover:underline')}>{children}</span>
      {trailing && <span className="flex shrink-0 items-center gap-2 text-sm text-muted">{trailing}</span>}
    </Tag>
  );
}

/** A ListRow to a typed route: the router's intent preloading applies. */
export const ListRowLink = createLink(ListRow);
