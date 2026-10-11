// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ChevronRight, PanelLeft} from 'lucide-react';
import {observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect} from 'react';
import {forgetRoute} from '../splash.ts';
import {useApp} from '../store.ts';
import {cx, Icon, IconButton, type LucideIcon} from '../../ui/index.ts';
import {shortcutHint} from '../shortcuts/index.ts';
import {HeaderBar, HeaderRow, HeaderStack, WhenSidebarAway} from './Frame.tsx';
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

/** How many not-found states are on screen: while one is, the tab says "Not found", whatever the page's header. */
const notFound = observable.box(0);

/** Whether the page on screen is a not-found state (the next boot does not resume it). */
export function showingNotFound(): boolean {
  return notFound.get() > 0;
}

/**
 * Marks the page as not found while `on`: the tab's title is "Not found" (an issue's page that names an issue
 * nobody has is not "#99999 · acme/atlas"), and the base URL does not resume it on the next boot.
 */
export function useNotFound(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    runInAction(() => { notFound.set(notFound.get() + 1); });
    forgetRoute();
    return () => { runInAction(() => { notFound.set(notFound.get() - 1); }); };
  }, [on]);
}

/** The tab's title: the page's, then the instance's name ("Issues · acme/atlas · Forgejo"). */
const DocumentTitle = observer(function DocumentTitle({text}: {text: string | undefined}) {
  const {config} = useApp();
  const shown = showingNotFound() ? 'Not found' : text;
  useEffect(() => {
    document.title = shown ? `${shown} · ${config.app_name}` : config.app_name;
  }, [shown, config.app_name]);
  return null;
});

/**
 * Every page's header bar: where you are, the page's controls, and the sync
 * indicator. On a wide panel the breadcrumb gives way first (ellipsis), then
 * the controls; the title (up to max-w-sm) and the indicator stay. On a narrow
 * panel the breadcrumb takes a row above and the controls wrap below the title.
 * Panel width, not viewport width, accounts for the space taken by the sidebar.
 */
export function PageHeader({title, icon, context, children, docTitle}: PageHeaderProps) {
  return (
    <HeaderBar>
      <DocumentTitle text={docTitle ?? (typeof title === 'string' ? title : undefined)}/>
      <SidebarToggle/>
      <PageIcon icon={icon}/>
      {context && (
        <nav aria-label="Breadcrumb" className="flex min-w-0 shrink-2 items-center gap-1 text-base text-fg-muted @max-xl:order-first @max-xl:w-full @max-xl:pt-2 @max-xl:text-sm">
          {context}
          <span className="flex @max-xl:hidden"><Icon icon={ChevronRight} size="sm" className="text-fg-subtle"/></span>
        </nav>
      )}
      <TitleAndControls title={title}>{children}</TitleAndControls>
      <HeaderEnd/>
    </HeaderBar>
  );
}

export interface StackedPageHeaderProps {
  /** The first row: where you are (a breadcrumb: "owner / repo"), beside the sync indicator. */
  context: ReactNode;
  /** Actions at the first row's end, before the sync indicator (a page without a title row). */
  actions?: ReactNode;
  /** Between the first row and the title row: a tab bar (a row of its own). */
  tabs?: ReactNode;
  /** The title row's title; undefined: no title row (the page's heading is in the breadcrumb). */
  title?: ReactNode;
  icon?: LucideIcon | undefined;
  /** The title row's controls (filters, view switches, a ref picker). */
  children?: ReactNode;
  /** The browser tab's title (default: the title when it is text). */
  docTitle?: string | undefined;
}

/**
 * A header of rows, as GitHub's repository pages: where you are (and the sync indicator) on top, then the tabs,
 * then the page's title with its controls. Each row has the header bar's height and gutter; the title row ends
 * as the one-row header does (the controls wrap below the title on a narrow panel). Without a title the page has
 * no title row (a repository's home: its heading is the breadcrumb's last crumb).
 */
export function StackedPageHeader({context, actions, tabs, title, icon, children, docTitle}: StackedPageHeaderProps) {
  return (
    <HeaderStack>
      <DocumentTitle text={docTitle ?? (typeof title === 'string' ? title : undefined)}/>
      <HeaderRow>
        <SidebarToggle/>
        {/* Reserve the row's remaining width for the breadcrumb at every panel size. */}
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-base text-fg-muted flex-1 basis-0 py-2">
          {context}
        </nav>
        <HeaderEnd before={actions}/>
      </HeaderRow>
      {tabs}
      {title !== undefined && (
        <HeaderRow>
          <PageIcon icon={icon}/>
          <TitleAndControls title={title}>{children}</TitleAndControls>
        </HeaderRow>
      )}
    </HeaderStack>
  );
}

/** The sidebar's toggle, while the sidebar is not beside the page. */
function SidebarToggle() {
  return <WhenSidebarAway><IconButton size="sm" icon={PanelLeft} label="Show the sidebar" shortcut={shortcutHint('sidebar.toggle')} onClick={toggleSidebar}/></WhenSidebarAway>;
}

/** The page's icon before its title (wide panels). */
function PageIcon({icon}: {icon: LucideIcon | undefined}) {
  return icon ? <span className="flex shrink-0 @max-xl:hidden"><Icon icon={icon} className="text-fg-subtle"/></span> : null;
}

/** The page's title and its controls. */
function TitleAndControls({title, children}: {title: ReactNode; children?: ReactNode}) {
  return (
    <>
      <h1 className={cx('min-w-0 truncate text-base font-medium text-fg @max-xl:max-w-none @max-xl:flex-1 @max-xl:basis-0 @max-xl:py-2', children ? 'max-w-sm @xl:shrink-0' : '@xl:shrink')}>{title}</h1>
      {children && <span aria-hidden className="hidden @max-xl:order-last @max-xl:block @max-xl:w-full"/>}
      {children && (
        <div className="flex min-w-0 shrink flex-wrap items-center gap-1 p-1 @max-xl:order-last @max-xl:w-full @max-xl:py-2">
          {children}
        </div>
      )}
    </>
  );
}

/** The header's right end: the sync indicator, `before` it a page's actions. */
function HeaderEnd({before}: {before?: ReactNode}) {
  return <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">{before}<SyncIndicator/></div>;
}
