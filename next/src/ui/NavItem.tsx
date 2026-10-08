// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ChevronDown, ChevronRight} from 'lucide-react';
import {Slot} from 'radix-ui';
import type {ButtonHTMLAttributes, ReactElement, ReactNode, Ref} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {Tooltip} from './Tooltip.tsx';

// Sidebar rows sit on the canvas, so they use the canvas fills (plain hover
// is too faint there). The current page is marked by aria-current="page",
// which router links set themselves.
const row =
  'interactive flex h-control w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-base text-fg-muted select-none ' +
  'hover:bg-canvas-hover hover:text-fg aria-[current=page]:bg-canvas-selected aria-[current=page]:text-fg ' +
  'data-[state=open]:bg-canvas-hover data-[state=open]:text-fg';

export interface NavItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style' | 'children'> {
  /** The visible name. */
  label: string;
  icon?: LucideIcon | undefined;
  /** Instead of an icon (an avatar; decorative: the label names the row). */
  leading?: ReactNode;
  /** A count on the right (unread, open). Hidden when 0 or undefined. */
  count?: number | undefined;
  /** One level in (an item of a NavGroup). */
  inset?: boolean | undefined;
  /** Shortcut hint, shown in a tooltip with the label. */
  shortcut?: string | undefined;
  /** Render the single child (a router <Link> without children) with the item's look and content. */
  asChild?: boolean | undefined;
  children?: ReactElement;
  ref?: Ref<HTMLButtonElement>;
}

/** One sidebar row: a link (asChild) or a button. */
export function NavItem({label, icon, leading, count, inset, shortcut, asChild, children, ...rest}: NavItemProps) {
  // The label names the row: an avatar next to it is decorative.
  const lead = icon ? <Icon icon={icon} className="text-fg-subtle"/> : leading && <span aria-hidden className="flex shrink-0">{leading}</span>;
  const name = <span className="min-w-0 flex-1 truncate">{label}</span>;
  const tally = count ? <span className="text-sm text-fg-subtle tabular-nums">{count}</span> : null;
  const cls = cx(row, inset && 'pl-7');
  // Slot needs the Slottable as a direct child (no fragment): the link becomes the row.
  const el = asChild ?
    <Slot.Root className={cls} {...rest}><Slot.Slottable>{children}</Slot.Slottable>{lead}{name}{tally}</Slot.Root> :
    <button type="button" className={cls} {...rest}>{lead}{name}{tally}</button>;
  return shortcut ? <Tooltip content={label} shortcut={shortcut} side="right">{el}</Tooltip> : el;
}

export interface NavGroupProps {
  label: string;
  leading?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** A collapsible group of sidebar rows (an owner and its repositories). Opens and closes instantly. */
export function NavGroup({label, leading, open, onOpenChange, children}: NavGroupProps) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-px">
      <button type="button" aria-expanded={open} className={row} onClick={() => {
        onOpenChange(!open);
      }}>
        {leading && <span aria-hidden className="flex shrink-0">{leading}</span>}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Icon icon={open ? ChevronDown : ChevronRight} size="sm" className="text-fg-subtle"/>
      </button>
      {open && children}
    </div>
  );
}

/** A small section heading in the sidebar. */
export function NavHeading({children}: {children: string}) {
  return <div className="flex h-control items-end px-2 pb-1 text-sm font-medium text-fg-subtle">{children}</div>;
}
