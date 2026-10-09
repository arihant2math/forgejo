// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The layout of the signed-in app: a sidebar on the canvas and the main
// panel. The boot shell (BootShell.tsx, static HTML in index.html) and the
// live shell (Shell.tsx) are both built from these parts, so the first frame
// and the app line up (PLAN §1: cache the shape of the page).

import type {ReactNode, Ref} from 'react';
import {cx, Skeleton} from '../../ui/index.ts';

/**
 * Wide screens: the sidebar beside the page (collapsible: sidebar-hidden). Narrow ones (below md): a drawer over
 * the page, opened from the page header's button (drawer-open), closed by the backdrop, Esc or navigating.
 */
export function ShellFrame({boot, sidebar, children, onBackdrop}: {boot?: boolean; sidebar: ReactNode; children: ReactNode; onBackdrop?: () => void}) {
  return (
    <div className={cx('flex h-full', boot && 'logged-out:hidden')}>
      <aside aria-label="Sidebar" className={drawer}>{sidebar}</aside>
      <div aria-hidden className="fixed inset-0 z-dialog hidden bg-overlay max-md:drawer-open:block" onClick={onBackdrop}/>
      <main className="@container flex min-w-0 flex-1 flex-col bg-surface">{children}</main>
    </div>
  );
}

const drawer = cx(
  'relative flex w-sidebar shrink-0 flex-col border-r border-border bg-canvas md:sidebar-hidden:hidden',
  'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-popover max-md:hidden max-md:w-pane max-md:shadow-dialog max-md:drawer-open:flex',
);

/** The sidebar's fixed top (account, search). */
export function SidebarTop({children}: {children: ReactNode}) {
  return <div className="flex flex-col gap-px p-2">{children}</div>;
}

/** The sidebar's scrolling part (navigation, workspace). */
export function SidebarBody({children}: {children: ReactNode}) {
  return <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2">{children}</nav>;
}

/**
 * The main panel's header bar. On a phone (below md) it may take a second row: the page's controls go under the
 * title (PageHeader), where they scroll sideways instead of being cut off.
 */
export function HeaderBar({children}: {children: ReactNode}) {
  return (
    <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4 max-md:h-auto max-md:min-h-header max-md:flex-wrap max-md:gap-x-2 max-md:gap-y-0 max-md:px-2">
      {children}
    </header>
  );
}

/** What shows only while the sidebar is not beside the page (collapsed, or a drawer on a narrow screen): its toggle. */
export function WhenSidebarAway({children}: {children: ReactNode}) {
  return <span className="hidden shrink-0 max-md:flex md:sidebar-hidden:flex">{children}</span>;
}

/** The page's scroll container, for the router's scroll restoration (router.tsx). */
export const PAGE_SCROLLER = '[data-scroll-restoration-id="page"]';

/**
 * A list view's options change (a filter, the grouping, the order): the page goes back to its top now, while the
 * layout is still clean, and the navigation that writes the view into the URL keeps its scroll
 * (`navigate({...viewChange(), …})`). The router's own reset ran after the new rows' commit: a forced synchronous
 * layout of the whole page, half of a 100 ms long task on a 4x slowed CPU (QA round 2).
 */
export function viewChange(): {resetScroll: false} {
  document.querySelector(PAGE_SCROLLER)?.scrollTo({top: 0});
  return {resetScroll: false};
}

/**
 * Virtualizer options for a list that scrolls the page (PageBody): its first rows render for the window's height,
 * and the scroller's size comes from a ResizeObserver (after layout, before paint), never from a
 * getBoundingClientRect in the list's layout effect, which forced a synchronous layout of the whole new page on
 * every navigation to a list (QA round 2).
 */
export function pageListRect() {
  return {
    initialRect: {width: innerWidth, height: innerHeight},
    observeElementRect: (instance: {scrollElement: Element | Window | null}, cb: (rect: {width: number; height: number}) => void) => {
      const el = instance.scrollElement;
      if (!(el instanceof Element) || typeof ResizeObserver !== 'function') return undefined;
      const observer = new ResizeObserver(([entry]) => {
        const box = entry?.borderBoxSize[0];
        if (box) cb({width: Math.round(box.inlineSize), height: Math.round(box.blockSize)});
      });
      observer.observe(el, {box: 'border-box'});
      return () => {
        observer.disconnect();
      };
    },
  };
}

/** The main panel's content below the header (the page's scroll container; lists virtualize against it). */
export function PageBody({children, ref}: {children: ReactNode; ref?: Ref<HTMLDivElement>}) {
  return <div ref={ref} data-scroll-restoration-id="page" className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
}

/** A sidebar row placeholder with a NavItem's geometry. */
const labelWidths = {sm: 'h-3 w-16', md: 'h-3 w-20', lg: 'h-3 w-24', xl: 'h-3 w-28'} as const;

/** `inset`: a repository row (no icon, label lined up with its owner's). */
export function NavSkeleton({width, leading, inset}: {width: keyof typeof labelWidths; leading?: ReactNode; inset?: boolean}) {
  return (
    <div className={inset ? 'flex h-control items-center gap-2 pr-2 pl-8' : 'flex h-control items-center gap-2 px-2'}>
      {inset ? null : leading ?? <Skeleton className="size-4"/>}
      <Skeleton className={labelWidths[width]}/>
    </div>
  );
}

/**
 * A page's reading column inside PageBody (Home, an owner, the boards): centred in the panel, the page gutter,
 * tighter on a narrow page. Every overview page uses it, so moving between them never shifts the content.
 * `wide`: the whole panel's width with the same gutter — every repository page that is not a list (its home,
 * a directory, releases, a pull request's checks); lists (issues, commits, branches, runs) go edge to edge.
 */
export function PageColumn({children, wide = false}: {children: ReactNode; wide?: boolean}) {
  return <div className={cx('flex min-w-0 flex-col gap-4 px-4 py-4 @xl:px-8 @xl:py-6', wide ? 'flex-1' : 'mx-auto w-full max-w-lg')}>{children}</div>;
}
