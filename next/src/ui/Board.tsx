// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {HTMLAttributes, ReactNode, Ref} from 'react';
import {cx} from './cx.ts';

export interface BoardColumnProps {
  /** The column's name (its listbox is labelled by it). */
  title: ReactNode;
  count: number;
  /** Before the title (a colour dot, a default marker). */
  leading?: ReactNode;
  /** After the count, right-aligned (the column's menu). */
  actions?: ReactNode;
  /** The column's cards (a virtualized listbox). */
  children: ReactNode;
  /** The scroll container of the cards (drag and drop measures it). */
  bodyRef?: Ref<HTMLDivElement>;
  /** Marks the column for drag and drop hit tests. */
  columnId: number;
}

/** A board's lane: a quiet canvas column of fixed width (the board scrolls sideways). */
const lane = 'flex w-column shrink-0 flex-col rounded-lg bg-canvas';

/**
 * One column of a board (Linear's): a quiet canvas lane with a header and
 * its own vertical scroll. Fixed width, so the board scrolls sideways.
 */
export function BoardColumn({title, count, leading, actions, children, bodyRef, columnId}: BoardColumnProps) {
  return (
    <section data-column={columnId} className={cx(lane, 'focus-visible-within')}>
      <header className="flex h-control shrink-0 items-center gap-2 px-3 pt-1 text-base">
        {leading}
        <h2 className="min-w-0 truncate font-medium text-fg">{title}</h2>
        <span className="text-sm text-fg-subtle tabular-nums">{count}</span>
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
  /** The title (wraps to two lines). */
  title: ReactNode;
  /** Last line: labels, assignees. */
  footer?: ReactNode;
  /** The card's issue page: the card is a link. */
  href?: string | undefined;
  ref?: Ref<HTMLElement>;
}

/**
 * A card on a board: fixed height (columns virtualize without measuring),
 * layout containment, hairline border on the surface. The cursor is an
 * accent border that moves instantly (no fade: a key held down leaves no
 * trail); a dragged card fades where it was. With `href` the card is a link
 * (middle-click, a new tab); the board handles a plain click.
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
      className={cx(
        'flex h-card cursor-default flex-col gap-1 overflow-hidden rounded-md border border-border bg-surface px-2.5 py-1.5 contain-content select-none',
        'hover:border-border-strong data-active:border-accent data-dragging:opacity-disabled',
      )}
      {...props}
    >
      <div className="flex h-4 items-center gap-1.5 text-sm text-fg-subtle tabular-nums">{meta}</div>
      <div className="clamp-title min-h-0 text-base text-fg">{title}</div>
      {footer && <div className="mt-auto flex min-w-0 items-center gap-1">{footer}</div>}
    </Tag>
  );
}

/** A column being added: the lane's look, its name being typed where the header goes. */
export function BoardColumnDraft({children}: {children: ReactNode}) {
  return <section aria-label="New column" className={cx(lane, 'gap-1 p-1.5')}>{children}</section>;
}

/** The insertion line shown while dragging a card (moved by transform: `drag-layer`). */
export function DropIndicator({ref}: {ref: Ref<HTMLDivElement>}) {
  return <div ref={ref} aria-hidden hidden className="drag-layer h-0.5 w-column rounded-full bg-accent"/>;
}
