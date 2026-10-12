// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ActionList, Text, TextInput} from '@primer/react';
import {KeybindingHint} from '@primer/react/experimental';
import {SearchIcon, type Icon} from '@primer/octicons-react';
import {defaultRangeExtractor, useVirtualizer} from '@tanstack/react-virtual';
import {type KeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useId, useRef} from 'react';

export interface PaletteRow {
  value: string;
  label: ReactNode;
  icon?: Icon | undefined;
  /** Replaces `icon` (an issue's coloured state). */
  leading?: ReactNode;
  meta?: ReactNode;
  /** Raw keymap notation, not a platform-formatted display string. */
  shortcut?: string | undefined;
  alternateShortcut?: string | undefined;
  destructive?: boolean | undefined;
  /** Unavailable commands still explain their reason on Enter, without closing. */
  muted?: boolean | undefined;
  run: () => void;
}

export interface PaletteGroup {
  heading: string;
  rows: PaletteRow[];
}

interface Props {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  groups: PaletteGroup[];
  selected: string;
  onSelectedChange: (value: string) => void;
  onChoose: (row: PaletteRow) => void;
  empty: ReactNode;
}

/** Keeps focus in the filter and exposes the cursor as its active descendant. */
export function PaletteList({inputRef, query, onQueryChange, groups, selected, onSelectedChange, onChoose, empty}: Props) {
  // TanStack Virtual exposes a mutable instance; React Compiler must not memoize reads from it.
  'use no memo';
  const id = useId();
  const listId = `${id}-results`;
  const rowId = useCallback((value: string) => `${id}-${encodeURIComponent(value)}`, [id]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = groups.flatMap((g) => g.rows);
  const index = rows.findIndex((r) => r.value === selected);
  const activeGroup = groups.findIndex((g) => g.rows.some((r) => r.value === selected));
  // Virtualize bounded groups, not rows, to preserve headings and accessible grouping.
  const virtual = rows.length > 50;
  // eslint-disable-next-line react/incompatible-library -- This component opts out of compiler memoization for TanStack Virtual.
  const virtualizer = useVirtualizer({
    count: groups.length,
    enabled: virtual,
    getScrollElement: () => scrollRef.current,
    getItemKey: (i) => groups[i]?.heading ?? i,
    estimateSize: (i) => 32 + (groups[i]?.rows.length ?? 0) * 40,
    overscan: 1,
    initialRect: {height: 384, width: 640},
    rangeExtractor: (range) => [...new Set([...defaultRangeExtractor(range), ...activeGroup >= 0 ? [activeGroup] : []])].sort((a, b) => a - b),
  });
  const firstInGroup = groups[activeGroup]?.rows[0]?.value === selected;
  useEffect(() => {
    if (!selected) return;
    const row = document.getElementById(rowId(selected));
    // Include the heading when scrolling to a group's first option.
    if (firstInGroup) document.getElementById(`${id}-heading-${String(activeGroup)}`)?.scrollIntoView({block: 'nearest'});
    row?.scrollIntoView({block: 'nearest'});
  }, [selected, id, activeGroup, firstInGroup, rowId]);

  const move = (next: number) => {
    const row = rows[next];
    if (row) onSelectedChange(row.value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const down = event.key === 'ArrowDown';
    const up = event.key === 'ArrowUp';
    if (down || up) {
      event.preventDefault();
      if (!rows.length) return;
      if (event.metaKey) move(down ? rows.length - 1 : 0);
      else if (event.altKey) {
        const nextGroup = groups[(activeGroup + (down ? 1 : -1) + groups.length) % groups.length];
        const row = nextGroup?.rows[0];
        if (row) onSelectedChange(row.value);
      } else move(index < 0 ? down ? 0 : rows.length - 1 : (index + (down ? 1 : -1) + rows.length) % rows.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      move(event.key === 'Home' ? 0 : rows.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[index];
      if (row) onChoose(row);
    }
    // Escape and Tab belong to the Dialog (close/focus trap); Mod+K still belongs to the global registry.
  };

  const renderGroup = (group: PaletteGroup, groupIndex: number) => (
    <ActionList role="presentation" disableFocusZone>
      <ActionList.Group role="group" aria-label={group.heading}>
        <ActionList.GroupHeading id={`${id}-heading-${String(groupIndex)}`}>{group.heading}</ActionList.GroupHeading>
        {group.rows.map((row) => {
          const LeadingIcon = row.icon;
          return (
            <ActionList.Item key={row.value} id={rowId(row.value)} role="option" tabIndex={-1}
              active={row.value === selected} selected={row.value === selected}
              onMouseDown={(event) => { event.preventDefault(); }}
              onPointerMove={() => { onSelectedChange(row.value); }}
              onSelect={() => { onChoose(row); }}>
              {row.leading ? <ActionList.LeadingVisual>{row.leading}</ActionList.LeadingVisual> : LeadingIcon && <ActionList.LeadingVisual><LeadingIcon/></ActionList.LeadingVisual>}
              {row.label}
              {row.meta && <ActionList.Description truncate>{row.meta}</ActionList.Description>}
              {row.shortcut && <ActionList.TrailingVisual>
                <span className="flex items-center gap-1"><KeybindingHint keys={row.shortcut}/>
                {row.alternateShortcut && <> or <KeybindingHint keys={row.alternateShortcut}/></>}</span>
              </ActionList.TrailingVisual>}
            </ActionList.Item>
          );
        })}
      </ActionList.Group>
    </ActionList>
  );
  return (
    <div className="flex flex-col gap-2">
      <TextInput ref={inputRef} size="large" block leadingVisual={SearchIcon} role="combobox" aria-label="Command menu"
        aria-controls={listId} aria-expanded aria-autocomplete="list"
        {...(index >= 0 ? {'aria-activedescendant': rowId(selected)} : {})}
        autoComplete="off" value={query} onChange={(event) => { onQueryChange(event.target.value); }}
        onKeyDown={onKeyDown} placeholder="Search or jump to…"/>
      {empty && <Text as="p" role="status">{empty}</Text>}
      <div ref={scrollRef} id={listId} role="listbox" aria-label="Command menu" className="max-h-96 overflow-y-auto">
        {virtual ? <div className="relative" style={{height: virtualizer.getTotalSize()}}>
          {virtualizer.getVirtualItems().map((item) => {
            const group = groups[item.index];
            return group ? <div key={item.key} data-index={item.index} ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full" style={{transform: `translateY(${String(item.start)}px)`}}>
              {renderGroup(group, item.index)}
            </div> : null;
          })}
        </div> : groups.map((group, groupIndex) => <div key={group.heading}>{renderGroup(group, groupIndex)}</div>)}
      </div>
    </div>
  );
}
