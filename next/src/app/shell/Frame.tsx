// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Shared boot/live layout keeps the static first frame aligned with the app.

import {elementScroll, type Virtualizer} from '@tanstack/react-virtual';
import type {ReactNode, Ref} from 'react';
import {clsx} from 'clsx';
import {SkeletonBox} from '@primer/react/experimental';

export function ShellFrame({boot, sidebar, children, onBackdrop}: {boot?: boolean; sidebar: ReactNode; children: ReactNode; onBackdrop?: () => void}) {
  return (
    <div className={clsx('flex h-full', boot && 'logged-out:hidden')}>
      <aside aria-label="Sidebar" className={drawer}>{sidebar}</aside>
      <div aria-hidden className="fixed inset-0 z-dialog hidden bg-overlay-backdrop max-md:drawer-open:block" onClick={onBackdrop}/>
      <main className="@container flex min-w-0 flex-1 flex-col bg-default">{children}</main>
    </div>
  );
}

const drawer = clsx(
  'relative flex w-sidebar shrink-0 flex-col border-r border-default bg-inset md:sidebar-hidden:hidden',
  'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-popover max-md:hidden max-md:w-pane max-md:shadow-dialog max-md:drawer-open:flex',
);

export function SidebarTop({children}: {children: ReactNode}) {
  return <div className="flex flex-col gap-2 p-2">{children}</div>;
}

export function SidebarBody({children}: {children: ReactNode}) {
  return <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{children}</div>;
}

const headerRow = 'flex min-h-header shrink-0 items-center gap-2 border-b border-default px-4 @max-xl:flex-wrap @max-xl:gap-x-2 @max-xl:gap-y-0 @max-xl:px-2';

export function HeaderRow({children}: {children: ReactNode}) {
  return <div className={headerRow}>{children}</div>;
}

export function HeaderStack({children}: {children: ReactNode}) {
  return <header className="flex shrink-0 flex-col">{children}</header>;
}

export function WhenSidebarAway({children}: {children: ReactNode}) {
  return <span className="hidden shrink-0 max-md:flex md:sidebar-hidden:flex">{children}</span>;
}

export const PAGE_SCROLLER = '[data-scroll-restoration-id="page"]';

/** Resets scroll before new rows commit, avoiding forced layout; subsequent URL navigation preserves it. */
export function viewChange(): {resetScroll: false} {
  document.querySelector(PAGE_SCROLLER)?.scrollTo({top: 0});
  return {resetScroll: false};
}

/** Uses window height for initial rows and ResizeObserver for page size, avoiding synchronous layout during navigation. */
export function pageListRect() {
  return {
    initialRect: {width: innerWidth, height: innerHeight},
    scrollToFn: pageScrollTo,
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

const mounted = new WeakSet<object>();

/** Skips the virtualizer's redundant mount scroll to avoid forced layout; router restoration runs after render. */
function pageScrollTo<T extends Element>(offset: number, options: Parameters<typeof elementScroll>[1], instance: Virtualizer<T, Element>): void {
  if (!mounted.has(instance)) {
    mounted.add(instance);
    if (offset === 0 && !options.adjustments) return;
  }
  elementScroll(offset, options, instance);
}

/** `bounded` creates a size container for sticky, independently scrolling panes. */
export function PageBody({children, ref, bounded = false}: {children: ReactNode; ref?: Ref<HTMLDivElement>; bounded?: boolean}) {
  return <div ref={ref} data-scroll-restoration-id="page" className={clsx('min-h-0 flex-1 overflow-y-auto', bounded && '@container-size')}>{children}</div>;
}

const labelWidths = {sm: 'h-3 w-16', md: 'h-3 w-20', lg: 'h-3 w-24', xl: 'h-3 w-28'} as const;

export function NavSkeleton({width, leading, inset}: {width: keyof typeof labelWidths; leading?: ReactNode; inset?: boolean}) {
  return (
    <div className={inset ? 'flex h-control items-center gap-2 pr-2 pl-8' : 'flex h-control items-center gap-2 px-2'}>
      {inset ? null : leading ?? <SkeletonBox className="size-4"/>}
      <SkeletonBox className={labelWidths[width]}/>
    </div>
  );
}

/** Shared reading-column gutters prevent navigation shifts; `wide` fills the panel. */
export function PageColumn({children, wide = false}: {children: ReactNode; wide?: boolean}) {
  return <div className={clsx('flex min-w-0 flex-col gap-4 px-4 py-4 @xl:px-8 @xl:py-6', wide ? 'flex-1' : 'mx-auto w-full max-w-lg')}>{children}</div>;
}
