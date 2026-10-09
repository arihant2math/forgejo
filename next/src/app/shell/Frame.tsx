// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The layout of the signed-in app: a sidebar on the canvas and the main
// panel. The boot shell (BootShell.tsx, static HTML in index.html) and the
// live shell (Shell.tsx) are both built from these parts, so the first frame
// and the app line up (PLAN §1: cache the shape of the page).

import type {ReactNode, Ref} from 'react';
import {cx, Skeleton} from '../../ui/index.ts';

export function ShellFrame({boot, sidebar, children}: {boot?: boolean; sidebar: ReactNode; children: ReactNode}) {
  return (
    <div className={cx('flex h-full', boot && 'logged-out:hidden')}>
      <aside aria-label="Sidebar" className="relative flex w-sidebar shrink-0 flex-col border-r border-border bg-canvas">{sidebar}</aside>
      <main className="flex min-w-0 flex-1 flex-col bg-surface">{children}</main>
    </div>
  );
}

/** The sidebar's fixed top (account, search). */
export function SidebarTop({children}: {children: ReactNode}) {
  return <div className="flex flex-col gap-px p-2">{children}</div>;
}

/** The sidebar's scrolling part (navigation, workspace). */
export function SidebarBody({children}: {children: ReactNode}) {
  return <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2">{children}</nav>;
}

/** The main panel's header bar. */
export function HeaderBar({children}: {children: ReactNode}) {
  return <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">{children}</header>;
}

/** The main panel's content below the header (the page's scroll container; lists virtualize against it). */
export function PageBody({children, ref}: {children: ReactNode; ref?: Ref<HTMLDivElement>}) {
  return <div ref={ref} className="min-h-0 flex-1 overflow-y-auto">{children}</div>;
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
