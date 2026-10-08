// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';
import {Icon, type LucideIcon} from '../../ui/index.ts';
import {HeaderBar} from './Frame.tsx';
import {SyncIndicator} from './SyncIndicator.tsx';

export interface PageHeaderProps {
  title: ReactNode;
  icon?: LucideIcon | undefined;
  /** Shown before the title, muted (a breadcrumb: "owner / repo"). */
  context?: ReactNode;
  /** Controls after the title (filters, view switches). */
  children?: ReactNode;
}

/** Every page's header bar: where you are, the page's controls, and the sync indicator. */
export function PageHeader({title, icon, context, children}: PageHeaderProps) {
  return (
    <HeaderBar>
      {icon && <Icon icon={icon} className="text-fg-subtle"/>}
      {context && <span className="flex min-w-0 shrink items-center gap-1 truncate text-base text-fg-muted">{context}<span aria-hidden>›</span></span>}
      <h1 className="min-w-0 shrink-0 truncate text-base font-medium text-fg">{title}</h1>
      <div className="flex min-w-0 flex-1 items-center gap-1">{children}</div>
      <SyncIndicator/>
    </HeaderBar>
  );
}
