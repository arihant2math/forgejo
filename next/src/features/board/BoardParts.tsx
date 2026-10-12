// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type HTMLAttributes, type ReactNode, type Ref, useCallback, useEffect, useRef} from 'react';
import {clsx} from 'clsx';
import {CounterLabel} from '@primer/react';
import {CARD_HEIGHT} from './geometry.ts';

export interface BoardColumnProps {
  /** The column's name (its listbox is labelled by it). */
  title: ReactNode;
  count: number;
  leading?: ReactNode;
  badge?: ReactNode;
  /** After the count, right-aligned (the column's menu). */
  actions?: ReactNode;
  children: ReactNode;
  /** The scroll container of the cards (drag and drop measures it). */
  bodyRef?: Ref<HTMLDivElement>;
  /** Marks the column for drag and drop hit tests. */
  columnId: number;
}

export interface BoardLanesProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'> {
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}

/** Edge fades indicate columns outside the horizontal viewport. */
export function BoardLanes({ref, children, ...rest}: BoardLanesProps) {
  const el = useRef<HTMLDivElement | null>(null);
  const update = useCallback(() => {
    const e = el.current;
    if (!e) return;
    const start = e.scrollLeft > 1;
    const end = e.scrollLeft + e.clientWidth < e.scrollWidth - 1;
    if (start !== e.hasAttribute('data-more-start')) e.toggleAttribute('data-more-start', start);
    if (end !== e.hasAttribute('data-more-end')) e.toggleAttribute('data-more-end', end);
  }, []);
  useEffect(() => {
    const e = el.current;
    if (!e) return undefined;
    update();
    const ro = new ResizeObserver(update);
    ro.observe(e);
    for (const c of e.children) ro.observe(c);
    return () => {
      ro.disconnect();
    };
  }, [update]);
  return (
    <div {...rest} ref={(node) => {
      el.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    }} onScroll={update} className="edge-fade-x flex min-h-0 flex-1 items-stretch gap-2 overflow-x-auto p-4">
      {children}
    </div>
  );
}

const lane = 'flex w-column shrink-0 flex-col rounded-md border border-default bg-muted';

export function BoardColumn({title, count, leading, badge, actions, children, bodyRef, columnId}: BoardColumnProps) {
  return (
    <section data-column={columnId} className={clsx(lane, 'focus-visible-within')}>
      <header className="flex min-h-10 shrink-0 items-center gap-2 px-4 py-2">
        {leading}
        <h2 className="min-w-0 truncate text-base font-semibold">{title}</h2>
        <CounterLabel>{count}</CounterLabel>
        {badge}
        {actions && <span className="ml-auto flex items-center">{actions}</span>}
      </header>
      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-2 pt-1">{children}</div>
    </section>
  );
}

export interface BoardCardProps extends Omit<HTMLAttributes<HTMLElement>, 'className' | 'style' | 'role' | 'title'> {
  /** The keyboard cursor. */
  active?: boolean | undefined;
  /** Being dragged (the ghost follows the pointer; the card stays as a faded placeholder). */
  dragging?: boolean | undefined;
  /** First line: number, status, priority. */
  meta: ReactNode;
  title: ReactNode;
  /** Last line: labels, assignees. */
  footer?: ReactNode;
  /** The card's issue page: the card is a link. */
  href?: string | undefined;
  ref?: Ref<HTMLElement>;
}

/**
 * Fixed height avoids per-card virtualizer measurements.
 * The cursor border changes instantly so held keys leave no fading trail.
 */
export function BoardCard({active, dragging, meta, title, footer, href, ...rest}: BoardCardProps) {
  const Tag = href === undefined ? 'div' : 'a';
  const {ref, ...props} = rest;
  return (
    <Tag
      ref={ref as Ref<HTMLDivElement & HTMLAnchorElement>}
      {...(href === undefined ? {} : {href, draggable: false})}
      role="option"
      aria-selected={Boolean(active)}
      data-active={active ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      className={clsx(
        'group flex cursor-default flex-col overflow-hidden rounded-md border border-default bg-default px-2 py-1 contain-content select-none',
        'hover:border-emphasis data-active:border-accent-emphasis data-dragging:opacity-disabled',
      )}
      {...props}
      style={{height: CARD_HEIGHT}}
    >
      <div className="mb-1 flex h-5 shrink-0 items-center gap-1 text-sm text-muted tabular-nums">{meta}</div>
      <div className="clamp-title h-10 shrink-0 text-base font-semibold text-default group-hover:text-accent group-hover:underline">{title}</div>
      {footer && <div className="mt-2 flex h-5 min-w-0 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap">{footer}</div>}
    </Tag>
  );
}

export function BoardColumnDraft({children}: {children: ReactNode}) {
  return <section aria-label="New column" className={clsx(lane, 'gap-2 p-2')}>{children}</section>;
}

export function DropIndicator({ref}: {ref: Ref<HTMLDivElement>}) {
  return <div ref={ref} aria-hidden hidden className="drag-layer h-0.5 w-column rounded-md bg-accent-emphasis"/>;
}
