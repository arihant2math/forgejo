// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ChevronRight} from 'lucide-react';
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

/**
 * Every page's header bar: where you are, the page's controls, and the sync
 * indicator. The breadcrumb and the title give way (ellipsis) before the
 * controls and the indicator do.
 */
export function PageHeader({title, icon, context, children}: PageHeaderProps) {
  return (
    <HeaderBar>
      {icon && <Icon icon={icon} className="text-fg-subtle"/>}
      {context && (
        <nav aria-label="Breadcrumb" className="flex min-w-0 shrink-2 items-center gap-1 text-base text-fg-muted">
          {context}
          <Icon icon={ChevronRight} size="sm" className="text-fg-subtle"/>
        </nav>
      )}
      <h1 className="min-w-0 truncate text-base font-medium text-fg">{title}</h1>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
      <div className="ml-auto flex shrink-0 items-center pl-2"><SyncIndicator/></div>
    </HeaderBar>
  );
}
