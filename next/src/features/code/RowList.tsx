// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Fixed-height rows virtualize against the page scroll container.

import {useVirtualizer} from '@tanstack/react-virtual';
import {CodeRow} from './CodeRow.tsx';
import {observer} from 'mobx-react-lite';
import {useRouterState} from '@tanstack/react-router';
import {type KeyboardEvent, type ReactNode, useCallback, useId, useLayoutEffect, useRef, useState} from 'react';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {plainClick} from '../../app/links.ts';
import {focusList, rememberedRow, rememberRow} from '../../app/listReturn.ts';

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
  onIntent?: ((item: T) => void) | undefined;
  /** Enables middle-click and new tabs; plain clicks still call onOpen. */
  linkOf?: ((item: T) => string) | undefined;
  /** Page-owned cursors remain visible without focus; movement calls onCursor. */
  cursor?: number | undefined;
  onCursor?: ((index: number) => void) | undefined;
}

function Item({id, start, active, parts, href, onClick, onEnter}: {id: string; start: number; active: boolean; parts: RowParts; href: string | undefined; onClick: () => void; onEnter: () => void}) {
  return (
    <div className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(start)}px)`}}>
      <CodeRow role="option" id={id} active={active} aria-selected={active} leading={parts.leading} trailing={parts.trailing} href={href} tabIndex={-1}
        onClick={(e) => {
          if (href !== undefined && !plainClick(e)) return;
          e.preventDefault();
          onClick();
        }} onPointerEnter={onEnter}>
        {parts.main}
      </CodeRow>
    </div>
  );
}

function RowListImpl<T>({items, scroller, label, keyOf, row, onOpen: openItem, onIntent, linkOf, cursor: owned, onCursor}: RowListProps<T>) {
  const id = useId();
  // Restore the opened row and focus when navigating Back.
  const here = useRouterState({select: (s) => `${s.location.pathname}${s.location.searchStr}`});
  const onOpen = (item: T) => {
    if (owned === undefined) rememberRow(here, keyOf(item));
    openItem(item);
  };
  const [own, setOwn] = useState(0);
  const cursor = owned ?? own;
  const setCursor = (n: number) => {
    if (onCursor) onCursor(n);
    else setOwn(n);
  };
  const [focused, setFocused] = useState(false);
  const [moved, setMoved] = useState(false);
  const shown = focused || moved || owned !== undefined;
  const list = useRef<HTMLDivElement | null>(null);
  const [place, margin] = useScrollMargin(scroller);
  const setList = useCallback((el: HTMLDivElement | null) => {
    list.current = el;
    place(el);
  }, [place]);
  const v = useVirtualizer({count: items.length, getScrollElement: () => scroller, estimateSize: rowSize, overscan: 10, scrollMargin: margin});
  useShortcutScope('list');
  const hasItems = items.length > 0;
  useLayoutEffect(() => {
    const back = rememberedRow(here);
    if (owned !== undefined || back === undefined || moved) return;
    const at = items.findIndex((it) => keyOf(it) === back);
    if (at < 0) return;
    setOwn(at);
    setMoved(true);
    v.scrollToIndex(at, {align: 'auto'});
    focusList(list.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the rows are there
  }, [hasItems]);
  const move = (d: number) => {
    const n = shown ? Math.max(0, Math.min(items.length - 1, cursor + d)) : cursor;
    setCursor(n);
    setMoved(true);
    v.scrollToIndex(n);
    list.current?.focus({preventScroll: true});
    const it = items[n];
    if (it !== undefined) onIntent?.(it);
  };
  useShortcut('list.next', () => {
    move(1);
  });
  useShortcut('list.prev', () => {
    move(-1);
  });
  useShortcut('list.open', () => {
    const it = items[cursor];
    if (shown && it !== undefined) onOpen(it);
  }, true, () => shown && items[cursor] !== undefined);
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.altKey) return;
    if (ev.key === 'ArrowDown') move(1);
    else if (ev.key === 'ArrowUp') move(-1);
    else if (ev.key === 'Enter') {
      const it = items[cursor];
      if (it !== undefined) onOpen(it);
    } else return;
    ev.preventDefault();
  };
  return (
    <div ref={setList} role="listbox" tabIndex={0} aria-label={label} aria-activedescendant={items.length ? `${id}-${String(cursor)}` : undefined} data-shortcuts=""
      onKeyDown={onKeyDown} onFocus={() => {
        setFocused(true);
      }} onBlur={() => {
        setFocused(false);
      }} className="relative focus-visible:outline-none" style={{height: v.getTotalSize()}}>
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

/** Rows may read synced entities, so the list must observe them. */
export const RowList = observer(RowListImpl) as typeof RowListImpl;
