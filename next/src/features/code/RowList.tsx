// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Fixed-height rows virtualize against the page scroll container.

import {useVirtualizer} from '@tanstack/react-virtual';
import {CodeRow} from './CodeRow.tsx';
import {observer} from 'mobx-react-lite';
import {useRouterState} from '@tanstack/react-router';
import {type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {plainClick} from '../../app/links.ts';
import {focusList, rememberedRow, rememberRow} from '../../app/listReturn.ts';

import {useScrollMargin} from './Lines.tsx';

export const ROW = 32;
const rowSize = () => ROW;
/** Rows a pointer or a held J/K only passes over are not prefetched. */
export const INTENT_DELAY = 120;

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
  /** Called once the cursor or the pointer settles on a row. */
  onIntent?: ((item: T) => void) | undefined;
  /** Enables middle-click and new tabs; plain clicks still call onOpen. */
  linkOf?: ((item: T) => string) | undefined;
  /** Page-owned cursors remain visible without focus; movement calls onCursor. */
  cursor?: number | undefined;
  onCursor?: ((index: number) => void) | undefined;
  /** Heads each run of consecutive items with the same group (GitHub's "Commits on …"); keep it stable. */
  groupOf?: ((item: T) => string) | undefined;
  groupIcon?: ReactNode;
}

/** Virtual rows: a group header or the item at an index; `rowOf` maps an item to its row. */
interface Layout {
  rows: ({head: string} | number)[];
  rowOf: number[];
}

function groupLayout<T>(items: readonly T[], groupOf: (item: T) => string): Layout {
  const rows: Layout['rows'] = [];
  const rowOf: number[] = [];
  let last: string | undefined;
  items.forEach((item, i) => {
    const g = groupOf(item);
    if (g !== last) rows.push({head: g});
    last = g;
    rowOf.push(rows.length);
    rows.push(i);
  });
  return {rows, rowOf};
}

function Item({id, start, active, parts, href, onClick, onEnter, onLeave}: {id: string; start: number; active: boolean; parts: RowParts; href: string | undefined; onClick: () => void; onEnter: () => void; onLeave: () => void}) {
  return (
    <div className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(start)}px)`}}>
      <CodeRow role="option" id={id} active={active} aria-selected={active} leading={parts.leading} trailing={parts.trailing} href={href} tabIndex={-1}
        onClick={(e) => {
          if (href !== undefined && !plainClick(e)) return;
          e.preventDefault();
          onClick();
        }} onPointerEnter={onEnter} onPointerLeave={onLeave}>
        {parts.main}
      </CodeRow>
    </div>
  );
}

function RowListImpl<T>({items, scroller, label, keyOf, row, onOpen: openItem, onIntent, linkOf, cursor: owned, onCursor, groupOf, groupIcon}: RowListProps<T>) {
  const id = useId();
  const layout = useMemo(() => (groupOf ? groupLayout(items, groupOf) : undefined), [items, groupOf]);
  const rowOf = (index: number) => layout?.rowOf[index] ?? index;
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
  const v = useVirtualizer({count: layout?.rows.length ?? items.length, getScrollElement: () => scroller, estimateSize: rowSize, overscan: 10, scrollMargin: margin});
  const intentTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settle = (item: T) => {
    clearTimeout(intentTimer.current);
    if (onIntent) intentTimer.current = setTimeout(() => { onIntent(item); }, INTENT_DELAY);
  };
  const unsettle = () => { clearTimeout(intentTimer.current); };
  useEffect(() => unsettle, []);
  useShortcutScope('list');
  const hasItems = items.length > 0;
  useLayoutEffect(() => {
    const back = rememberedRow(here);
    if (owned !== undefined || back === undefined || moved) return;
    const at = items.findIndex((it) => keyOf(it) === back);
    if (at < 0) return;
    setOwn(at);
    setMoved(true);
    v.scrollToIndex(rowOf(at), {align: 'auto'});
    focusList(list.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the rows are there
  }, [hasItems]);
  const move = (d: number) => {
    const n = shown ? Math.max(0, Math.min(items.length - 1, cursor + d)) : cursor;
    setCursor(n);
    setMoved(true);
    v.scrollToIndex(rowOf(n));
    list.current?.focus({preventScroll: true});
    const it = items[n];
    if (it !== undefined) settle(it);
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
        const r = layout ? layout.rows[it.index] : it.index;
        if (r === undefined) return null;
        if (typeof r !== 'number') {
          // A listbox owns only options: the day header is visual, and each row reads its own date.
          return (
            <div key={`head:${String(it.index)}`} aria-hidden className="absolute inset-x-0 top-0 flex h-row items-center gap-2 border-b border-muted bg-muted px-4 text-sm text-muted" style={{transform: `translateY(${String(it.start - margin)}px)`}}>
              {groupIcon}{r.head}
            </div>
          );
        }
        const item = items[r];
        if (item === undefined) return null;
        return (
          <Item key={keyOf(item)} id={`${id}-${String(r)}`} start={it.start - margin} active={shown && r === cursor} parts={row(item)} href={linkOf?.(item)}
            onClick={() => {
              setCursor(r);
              onOpen(item);
            }}
            onEnter={() => { settle(item); }} onLeave={unsettle}/>
        );
      })}
    </div>
  );
}

/** Rows may read synced entities, so the list must observe them. */
export const RowList = observer(RowListImpl) as typeof RowListImpl;
