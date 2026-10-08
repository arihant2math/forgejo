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
import {ListRow} from '../../ui/index.ts';
import {useScrollMargin} from './Lines.tsx';

const ROW = 32;
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
}

function Item({id, start, active, parts, onClick, onEnter}: {id: string; start: number; active: boolean; parts: RowParts; onClick: () => void; onEnter: () => void}) {
  return (
    <div className="absolute inset-x-0 top-0" style={{transform: `translateY(${String(start)}px)`}}>
      <ListRow role="option" id={id} active={active} leading={parts.leading} trailing={parts.trailing} onClick={onClick} onPointerEnter={onEnter}>
        {parts.main}
      </ListRow>
    </div>
  );
}

function RowListImpl<T>({items, scroller, label, keyOf, row, onOpen, onIntent}: RowListProps<T>) {
  const id = useId();
  const [cursor, setCursor] = useState(0);
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
    if (ev.key === 'ArrowDown') move(1);
    else if (ev.key === 'ArrowUp') move(-1);
    else if (ev.key === 'Enter') {
      const it = items[cursor];
      if (it !== undefined) onOpen(it);
    } else return;
    ev.preventDefault();
  };
  return (
    <div ref={place} role="listbox" tabIndex={0} aria-label={label} aria-activedescendant={items.length ? `${id}-${String(cursor)}` : undefined} data-shortcuts=""
      onKeyDown={onKeyDown} className="relative outline-none focus-visible:outline-offset-0" style={{height: v.getTotalSize()}}>
      {v.getVirtualItems().map((it) => {
        const item = items[it.index];
        if (item === undefined) return null;
        return (
          <Item key={keyOf(item)} id={`${id}-${String(it.index)}`} start={it.start - margin} active={it.index === cursor} parts={row(item)}
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
