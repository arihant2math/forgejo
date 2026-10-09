// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ChevronRight, PanelLeft} from 'lucide-react';
import {type ReactNode, useEffect} from 'react';
import {useApp} from '../store.ts';
import {Icon, IconButton, type LucideIcon} from '../../ui/index.ts';
import {shortcutHint} from '../shortcuts/index.ts';
import {HeaderBar, WhenSidebarAway} from './Frame.tsx';
import {toggleSidebar} from './sidebar.ts';
import {SyncIndicator} from './SyncIndicator.tsx';

export interface PageHeaderProps {
  title: ReactNode;
  icon?: LucideIcon | undefined;
  /** Shown before the title, muted (a breadcrumb: "owner / repo"). */
  context?: ReactNode;
  /** Controls after the title (filters, view switches). */
  children?: ReactNode;
  /** The browser tab's title (default: the title when it is text). */
  docTitle?: string | undefined;
}

/** The tab's title: the page's, then the instance's name ("Issues · acme/atlas · Forgejo"). */
function DocumentTitle({text}: {text: string | undefined}) {
  const {config} = useApp();
  useEffect(() => {
    document.title = text ? `${text} · ${config.app_name}` : config.app_name;
  }, [text, config.app_name]);
  return null;
}

/**
 * Every page's header bar: where you are, the page's controls, and the sync
 * indicator. On a wide panel the breadcrumb gives way first (ellipsis), then
 * the controls; the title (up to max-w-sm) and the indicator stay. On a phone
 * the breadcrumb is a small row above, the title truncates beside the
 * indicator and the controls take a row of their own below, scrolling
 * sideways (every filter and menu stays reachable).
 */
export function PageHeader({title, icon, context, children, docTitle}: PageHeaderProps) {
  return (
    <HeaderBar>
      <DocumentTitle text={docTitle ?? (typeof title === 'string' ? title : undefined)}/>
      <WhenSidebarAway><IconButton size="sm" icon={PanelLeft} label="Show the sidebar" shortcut={shortcutHint('sidebar.toggle')} onClick={toggleSidebar}/></WhenSidebarAway>
      {icon && <span className="flex max-md:hidden"><Icon icon={icon} className="text-fg-subtle"/></span>}
      {context && (
        <nav aria-label="Breadcrumb" className="flex min-w-0 shrink-2 items-center gap-1 text-base text-fg-muted max-md:order-first max-md:w-full max-md:pt-2 max-md:text-sm">
          {context}
          <span className="flex max-md:hidden"><Icon icon={ChevronRight} size="sm" className="text-fg-subtle"/></span>
        </nav>
      )}
      <h1 className="max-w-sm min-w-0 truncate text-base font-medium text-fg max-md:max-w-none max-md:flex-1 max-md:basis-0 max-md:py-2 md:shrink-0">{title}</h1>
      {/* Controls give way on a narrow panel (the search narrows, the rest clips) before the title and the indicator do;
          on a phone they are a scrolling row under the title. The padding keeps their focus rings inside the clip. */}
      {children && (
        <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden p-1 max-md:order-last max-md:-mx-2 max-md:w-full max-md:overflow-x-auto max-md:px-2 max-md:scrollbar-none">
          {children}
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center pl-2"><SyncIndicator/></div>
    </HeaderBar>
  );
}
