// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {HTMLAttributes, ReactNode, Ref} from 'react';
import {cx} from './cx.ts';

export interface ListRowProps extends Omit<HTMLAttributes<HTMLElement>, 'role' | 'className' | 'style'> {
  /**
   * The row's role in its list: option (listbox), row (grid; the slots become gridcells) or presentation
   * (skeletons); undefined for a plain link row (a list of links: the anchor's own role).
   */
  role: 'option' | 'row' | 'presentation' | undefined;
  /** Part of the selection (multi-select, X). */
  selected?: boolean | undefined;
  /** The keyboard cursor (J/K), separate from the selection. */
  active?: boolean | undefined;
  /** Fixed-width slot before the title (status icon, avatar, …). */
  leading?: ReactNode;
  /** Right-aligned metadata (labels, assignee, date, …). */
  trailing?: ReactNode;
  /**
   * The row is a link to this URL (an anchor: middle-click, open in a new tab, copy link). The list still
   * handles a plain click (onClick, e.g. the router's navigation, see app/links.ts useLinkClick).
   */
  href?: string | undefined;
  ref?: Ref<HTMLElement>;
}

const slot = 'flex shrink-0 items-center gap-2';

/** The geometry every list row shares (rows and group headers): fixed height, so virtualized lists never measure. */
const rowBase = 'flex h-row items-center gap-2 border-b border-border-subtle px-3 contain-content';

/**
 * One compact list row (issues, PRs, notifications). Fixed height and layout
 * containment, so virtualized lists can position rows without measuring. The
 * focus outline is drawn inside: rows are full width and sit edge to edge.
 * Keyboard movement (roving tabindex, J/K) belongs to the list (F4).
 */
export function ListRow({role, selected, active, leading, trailing, href, children, ref, ...rest}: ListRowProps) {
  const cell = role === 'row' ? 'gridcell' : undefined;
  const Tag = href === undefined ? 'div' : 'a';
  return (
    <Tag
      ref={ref as Ref<HTMLDivElement & HTMLAnchorElement>}
      {...(href === undefined ? {} : {href})}
      role={role}
      data-selected={selected ? '' : undefined}
      data-active={active ? '' : undefined}
      aria-selected={role === 'presentation' || role === undefined ? undefined : Boolean(selected)}
      className={cx(
        rowBase,
        // The cursor (J/K) is an accent edge on a filled row (Linear's), the selection (X) an accent tint: both
        // distinct from the pointer's hover, in both themes. No fade: the cursor moves instantly (a key held down
        // leaves no trail).
        'row-cursor relative text-base text-fg hover:bg-hover data-active:not-data-selected:bg-selected data-selected:bg-accent-subtle',
      )}
      {...rest}
    >
      {leading && <span role={cell} className={cx(slot, 'text-fg-muted')}>{leading}</span>}
      <span role={cell} className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && <span role={cell} className={cx(slot, 'text-sm text-fg-muted')}>{trailing}</span>}
    </Tag>
  );
}

export interface ListGroupHeaderProps {
  /** An icon or dot before the label. */
  leading?: ReactNode;
  label: ReactNode;
  count: number;
}

/**
 * A group's header inside a list (grouped by status, assignee, …): a row of
 * the same height as ListRow, so virtualized lists keep a fixed row size.
 */
export function ListGroupHeader({leading, label, count}: ListGroupHeaderProps) {
  return (
    <div role="presentation" className={cx(rowBase, 'bg-canvas text-sm font-medium text-fg')}>
      {leading && <span className={cx(slot, 'text-fg-muted')}>{leading}</span>}
      <span className="min-w-0 truncate">{label}</span>
      <span className="text-fg-subtle tabular-nums">{count}</span>
    </div>
  );
}
