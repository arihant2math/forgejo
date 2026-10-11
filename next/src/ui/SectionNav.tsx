// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Slot} from 'radix-ui';
import type {ReactElement, ReactNode} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {sectionLabel} from './recipes.ts';

/**
 * The sections of a page with many (a repository's settings, like GitHub's): a column of links beside the
 * content on a wide panel, a row that scrolls sideways above it on a narrow one. The current section is the
 * link with aria-current="page" (router links set it).
 */
export function SectionNav({label, children}: {label: string; children: ReactNode}) {
  return <nav aria-label={label} className="flex shrink-0 gap-px overflow-x-auto @xl:w-48 @xl:flex-col @xl:overflow-visible">{children}</nav>;
}

/** A small heading over a group of section links (hidden on a narrow panel, where the links are one row). */
export function SectionNavHeading({children}: {children: string}) {
  return <h2 className={cx(sectionLabel, 'hidden px-2 pt-3 pb-1 font-medium @xl:block')}>{children}</h2>;
}

export interface SectionNavLinkProps {
  label: string;
  icon?: LucideIcon | undefined;
  /** Muted text after the label ("classic": the link opens the classic UI). */
  hint?: string | undefined;
  /** The router <Link> or <a>, without children: it becomes the row. */
  children: ReactElement;
}

/** One section link. */
export function SectionNavLink({label, icon, hint, children}: SectionNavLinkProps) {
  return (
    <Slot.Root className="interactive flex h-control shrink-0 items-center gap-2 rounded-md px-2 text-base whitespace-nowrap text-fg-muted hover:bg-hover hover:text-fg aria-[current=page]:bg-selected aria-[current=page]:text-fg">
      <Slot.Slottable>{children}</Slot.Slottable>
      {icon && <Icon icon={icon} size="sm" className="text-fg-subtle"/>}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="text-sm text-fg-subtle">{hint}</span>}
    </Slot.Root>
  );
}
