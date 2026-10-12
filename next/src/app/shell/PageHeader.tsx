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
import {IconButton, PageHeader as PrimerPageHeader, Text} from '@primer/react';

export interface PageHeaderProps {
  title: ReactNode;
  icon?: OcticonType | undefined;
  /** Breadcrumbs (`Crumbs`) above the title. */
  context?: ReactNode;
  children?: ReactNode;
  /** The browser tab's title (default: the title when it is text). */
  docTitle?: string | undefined;
  /** Keeps the h1 in a quiet breadcrumb when the body displays a large title. */
  leaf?: boolean | undefined;
}

const notFound = observable.box(0);
const pageStatuses = observable.array<string>();

/** Not-found pages must not be resumed on the next boot. */
export function showingNotFound(): boolean {
  return notFound.get() > 0;
}

/** Overrides the tab title for missing content and prevents resuming that page at boot. */
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

const DocumentTitle = observer(function DocumentTitle({text}: {text: string | undefined}) {
  const {config} = useApp();
  const shown = pageStatuses.at(-1) ?? (showingNotFound() ? 'Not found' : text);
  useEffect(() => {
    document.title = shown ? `${shown} · ${config.app_name}` : config.app_name;
  }, [shown, config.app_name]);
  return null;
});

/** Responsive layout follows panel width, not viewport width, to account for the sidebar. */
export function PageHeader({title, icon, context, children, docTitle, leaf = false}: PageHeaderProps) {
  return (
    <header className="min-h-header shrink-0 border-b border-default px-4 py-2">
      <DocumentTitle text={docTitle ?? (typeof title === 'string' ? title : undefined)}/>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className={leaf ? 'header-leaf min-w-0 flex-1' : 'min-w-0 flex-1'}>
          <PrimerPageHeader>
            {context && <PrimerPageHeader.Breadcrumbs>{context}</PrimerPageHeader.Breadcrumbs>}
            <PrimerPageHeader.LeadingAction hidden={false} className="hidden shrink-0 max-md:flex md:sidebar-hidden:flex"><SidebarToggle/></PrimerPageHeader.LeadingAction>
            <PrimerPageHeader.TitleArea className="min-w-0">
              {leaf ? (
                // Keep the heading slot's line-height so smaller leaf text does not move the page below.
                <div className="flex min-h-lh min-w-0 flex-1 items-center gap-2">
                  {icon && <span className="flex shrink-0 items-center">{pageIcon(icon)}</span>}
                  <Text as="h1" size="medium" weight="normal" className="min-w-0 flex-1 truncate" aria-current="page">{title}</Text>
                </div>
              ) : <>
                {icon && <PrimerPageHeader.LeadingVisual>{pageIcon(icon)}</PrimerPageHeader.LeadingVisual>}
                <PrimerPageHeader.Title as="h1">{title}</PrimerPageHeader.Title>
              </>}
            </PrimerPageHeader.TitleArea>
          </PrimerPageHeader>
        </div>
        <div className={headerActions}>{children}<SyncIndicator/></div>
      </div>
    </header>
  );
}

export interface StackedPageHeaderProps {
  /** Breadcrumbs (`Crumbs`) in the top row. */
  context: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  /** Undefined omits the title row; a visually hidden heading then names the page after docTitle. */
  title?: ReactNode;
  icon?: OcticonType | undefined;
  children?: ReactNode;
  /** The browser tab's title (default: the title when it is text). */
  docTitle?: string | undefined;
  /**
   * Set when the title is not phrasing content (a path's breadcrumb nav), which may not sit inside a heading:
   * the title row is then a plain block and a visually hidden h1 names the page with this text, as GitHub follows its path nav with an h1.
   */
  heading?: string | undefined;
}

export function StackedPageHeader({context, actions, tabs, title, icon, children, docTitle, heading}: StackedPageHeaderProps) {
  return (
    <header className="shrink-0">
      <DocumentTitle text={docTitle ?? (typeof title === 'string' ? title : undefined)}/>
      <div className="min-h-header px-4 py-2">
        <PrimerPageHeader>
          <PrimerPageHeader.ContextArea hidden={false}>
            <PrimerPageHeader.ContextBar hidden={false}>
              <div className="flex min-w-0 items-center gap-2">
                <SidebarToggle/>
                {context}
              </div>
            </PrimerPageHeader.ContextBar>
            <PrimerPageHeader.ContextAreaActions hidden={false}>
              <div className="flex items-center gap-2">{actions}<SyncIndicator/></div>
            </PrimerPageHeader.ContextAreaActions>
          </PrimerPageHeader.ContextArea>
        </PrimerPageHeader>
      </div>
      {tabs}
      {title === undefined && docTitle && <h1 className="sr-only">{docTitle}</h1>}
      {title !== undefined && (
        <div className="min-h-header border-b border-default px-4 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <PrimerPageHeader>
                <PrimerPageHeader.TitleArea className="min-w-0">
                  {icon && <PrimerPageHeader.LeadingVisual>{pageIcon(icon)}</PrimerPageHeader.LeadingVisual>}
                  {heading === undefined ? <PrimerPageHeader.Title as="h1">{title}</PrimerPageHeader.Title> : <>
                    <h1 className="sr-only">{heading}</h1>
                    {/* Keep the heading slot's line-height so the row matches titled pages. */}
                    <div className="flex min-h-lh min-w-0 flex-1 items-center">{title}</div>
                  </>}
                </PrimerPageHeader.TitleArea>
              </PrimerPageHeader>
            </div>
            {children && <div className={headerActions}>{children}</div>}
          </div>
        </div>
      )}
    </header>
  );
}

// Only visible controls cause toolbar wrapping; a quiet sync indicator must not create an empty row.
const headerActions = 'flex min-w-0 flex-wrap items-center gap-2 @max-xl:with-controls:basis-full';

function SidebarToggle() {
  return <WhenSidebarAway><IconButton icon={SidebarExpandIcon} variant="invisible" size="small" aria-label="Show the sidebar" description="Show the sidebar" keybindingHint={KEYMAP['sidebar.toggle'].keys} type="button" onClick={toggleSidebar}/></WhenSidebarAway>;
}

function pageIcon(Icon: OcticonType) {
  return <Icon size={16}/>;
}
