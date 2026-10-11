// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {observable, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect} from 'react';
import {forgetRoute} from '../splash.ts';
import {useApp} from '../store.ts';

import {KEYMAP} from '../shortcuts/index.ts';
import {WhenSidebarAway} from './Frame.tsx';
import {toggleSidebar} from './sidebar.ts';
import {SyncIndicator} from './SyncIndicator.tsx';
import {SidebarExpandIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {IconButton, PageHeader as PrimerPageHeader} from '@primer/react';

export interface PageHeaderProps {
  title: ReactNode;
  icon?: OcticonType | undefined;
  /** Shown before the title, muted (a breadcrumb: "owner / repo"). */
  context?: ReactNode;
  /** Controls after the title (filters, view switches). */
  children?: ReactNode;
  /** The browser tab's title (default: the title when it is text). */
  docTitle?: string | undefined;
}

/** How many not-found states are on screen: while one is, the tab says "Not found", whatever the page's header. */
const notFound = observable.box(0);
const pageStatuses = observable.array<string>();

/** Whether the page on screen is a not-found state (the next boot does not resume it). */
export function showingNotFound(): boolean {
  return notFound.get() > 0;
}

/**
 * Marks the page as not found while `on`: the tab's title is "Not found" (an issue's page that names an issue
 * nobody has is not "#99999 · acme/atlas"), and the base URL does not resume it on the next boot.
 */
export function usePageStatus(title: string | undefined): void {
  useEffect(() => {
    if (!title) return;
    runInAction(() => { pageStatuses.push(title); });
    return () => { runInAction(() => { pageStatuses.splice(pageStatuses.indexOf(title), 1); }); };
  }, [title]);
}

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
  const shown = pageStatuses.at(-1) ?? (showingNotFound() ? 'Not found' : text);
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
    <header className="shrink-0 border-b border-default px-4 py-3">
    <PrimerPageHeader>
      <DocumentTitle text={docTitle ?? (typeof title === 'string' ? title : undefined)}/>
      {context && <PrimerPageHeader.Breadcrumbs><nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">{context}</nav></PrimerPageHeader.Breadcrumbs>}
      <PrimerPageHeader.TitleArea>
        <PrimerPageHeader.LeadingAction><SidebarToggle/></PrimerPageHeader.LeadingAction>
        {icon && <PrimerPageHeader.LeadingVisual>{pageIcon(icon)}</PrimerPageHeader.LeadingVisual>}
        <PrimerPageHeader.Title as="h1">{title}</PrimerPageHeader.Title>
      </PrimerPageHeader.TitleArea>
      <PrimerPageHeader.Actions className="flex flex-wrap items-center gap-2">
        {children}<SyncIndicator/>
      </PrimerPageHeader.Actions>
    </PrimerPageHeader>
    </header>
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
  icon?: OcticonType | undefined;
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
    <header className="shrink-0">
      <DocumentTitle text={docTitle ?? (typeof title === 'string' ? title : undefined)}/>
      <div className="px-4 py-3">
      <PrimerPageHeader>
        <PrimerPageHeader.ContextBar hidden={false}>
          <PrimerPageHeader.ContextArea hidden={false}>
            <div className="flex min-w-0 items-center gap-2">
              <SidebarToggle/>
              <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1">{context}</nav>
            </div>
          </PrimerPageHeader.ContextArea>
          <PrimerPageHeader.ContextAreaActions hidden={false}>
            <div className="flex items-center gap-2">{actions}<SyncIndicator/></div>
          </PrimerPageHeader.ContextAreaActions>
        </PrimerPageHeader.ContextBar>
      </PrimerPageHeader>
      </div>
      {tabs}
      {title !== undefined && (
        <div className="border-b border-default px-4 py-3">
        <PrimerPageHeader>
          <PrimerPageHeader.TitleArea variant="subtitle">
            {icon && <PrimerPageHeader.LeadingVisual>{pageIcon(icon)}</PrimerPageHeader.LeadingVisual>}
            <PrimerPageHeader.Title as="h1">{title}</PrimerPageHeader.Title>
          </PrimerPageHeader.TitleArea>
          {children && <PrimerPageHeader.Actions className="flex flex-wrap items-center gap-2">{children}</PrimerPageHeader.Actions>}
        </PrimerPageHeader>
        </div>
      )}
    </header>
  );
}

/** The sidebar's toggle, while the sidebar is not beside the page. */
function SidebarToggle() {
  return <WhenSidebarAway><IconButton icon={SidebarExpandIcon} variant="invisible" size="small" aria-label="Show the sidebar" description="Show the sidebar" keybindingHint={KEYMAP['sidebar.toggle'].keys} type="button" onClick={toggleSidebar}/></WhenSidebarAway>;
}

function pageIcon(Icon: OcticonType) {
  return <Icon size={16}/>;
}
