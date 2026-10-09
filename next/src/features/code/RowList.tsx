// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The one list of the code views (files of a directory, commits, branches,
// tags, workflow runs): ListRow rows in the page's scroll container,
// virtualized (fixed row height, nothing measured), a listbox with a
// keyboard cursor (J/K or the arrows, Enter opens), hover/cursor prefetch.

import {useVirtualizer} from '@tanstack/react-virtual';
import {observer} from 'mobx-react-lite';
import {type KeyboardEvent, type ReactNode, useId, useState} from 'react';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {plainClick} from '../../app/links.ts';
import {ListRow} from '../../ui/index.ts';
import {useScrollMargin} from './Lines.tsx';

export const ROW = 32;
const rowSize = () => ROW;

export interface RowParts {
  leading?: ReactNode;
  trailing?: ReactNode;
  main: ReactNode;
}

interface RowListProps<T> {
  items: readonly T[];
  scroller: HTMLElement | null;
  label: string;
  keyOf: (item: T) => string;
  row: (item: T) => RowParts;
  onOpen: (item: T) => void;
  /** Hover or the cursor reached it (fetch what opening it needs). */
  onIntent?: ((item: T) => void) | undefined;
  /** The row's link (an anchor: middle-click, a new tab); a plain click still calls onOpen. */
  linkOf?: ((item: T) => string) | undefined;
  /**
   * A cursor owned by the page (the PR's file list follows the diff: one cursor, the file in view): shown
   * whether or not the list has focus; moving it calls onCursor.
   */
  cursor?: number | undefined;
  onCursor?: ((index: number) => void) | undefined;
  /** Backspace or Alt+ArrowUp: back out of the list (a directory's parent). */
  onBack?: (() => void) | undefined;
}

function Item({id, start, active, parts, href, onClick, onEnter}: {id: string; start: number; active: boolean; parts: RowParts; href: string | undefined; onClick: () => void; onEnter: () => void}) {
  return (
    <div className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(start)}px)`}}>
      <ListRow role="option" id={id} active={active} aria-selected={active} leading={parts.leading} trailing={parts.trailing} href={href} tabIndex={-1}
        onClick={(e) => {
          if (href !== undefined && !plainClick(e)) return;
          e.preventDefault();
          onClick();
        }} onPointerEnter={onEnter}>
        {parts.main}
      </ListRow>
    </div>
  );
}

function RowListImpl<T>({items, scroller, label, keyOf, row, onOpen, onIntent, linkOf, cursor: owned, onCursor, onBack}: RowListProps<T>) {
  const id = useId();
  const [own, setOwn] = useState(0);
  const cursor = owned ?? own;
  const setCursor = (n: number) => {
    if (onCursor) onCursor(n);
    else setOwn(n);
  };
  // The cursor's edge shows while the list has focus (or always, for a page-owned cursor).
  const [focused, setFocused] = useState(false);
  const shown = focused || owned !== undefined;
  const [place, margin] = useScrollMargin(scroller);
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer re-renders this list itself (rows are not memoized)
  const v = useVirtualizer({count: items.length, getScrollElement: () => scroller, estimateSize: rowSize, overscan: 10, scrollMargin: margin});
  useShortcutScope('list');
  const move = (d: number) => {
    const n = Math.max(0, Math.min(items.length - 1, cursor + d));
    setCursor(n);
    v.scrollToIndex(n);
    const it = items[n];
    if (it !== undefined) onIntent?.(it);
  };
  useShortcut('list.next', () => {
    move(1);
  });
  useShortcut('list.prev', () => {
    move(-1);
  });
  const onKeyDown = (ev: KeyboardEvent) => {
    if (onBack && (ev.key === 'Backspace' || (ev.key === 'ArrowUp' && ev.altKey))) onBack();
    else if (ev.key === 'ArrowDown') move(1);
    else if (ev.key === 'ArrowUp') move(-1);
    else if (ev.key === 'Enter') {
      const it = items[cursor];
      if (it !== undefined) onOpen(it);
    } else return;
    ev.preventDefault();
  };
  return (
    <div ref={place} role="listbox" tabIndex={0} aria-label={label} aria-activedescendant={items.length ? `${id}-${String(cursor)}` : undefined} data-shortcuts=""
      onKeyDown={onKeyDown} onFocus={() => {
        setFocused(true);
      }} onBlur={() => {
        setFocused(false);
      }} className="relative focus-visible:outline-offset-0" style={{height: v.getTotalSize()}}>
      {v.getVirtualItems().map((it) => {
        const item = items[it.index];
        if (item === undefined) return null;
        return (
          <Item key={keyOf(item)} id={`${id}-${String(it.index)}`} start={it.start - margin} active={shown && it.index === cursor} parts={row(item)} href={linkOf?.(item)}
            onClick={() => {
              setCursor(it.index);
              onOpen(item);
            }}
            onEnter={() => onIntent?.(item)}/>
        );
      })}
    </div>
  );
}

/** (An observer: rows may read synced entities.) */
export const RowList = observer(RowListImpl) as typeof RowListImpl;
