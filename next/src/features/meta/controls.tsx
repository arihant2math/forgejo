// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useEffect, useRef, useState} from 'react';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {ArrowSwitchIcon, SearchIcon} from '@primer/octicons-react';
import {Button, TextInput, ActionMenu, ActionList} from '@primer/react';

/** onChange runs per keystroke; onSettle runs after the debounce. */
export function PageSearch({value, label, onChange, onSettle}: {value: string; label: string; onChange: (q: string) => void; onSettle: (q: string) => void}) {
  const ref = useRef<HTMLInputElement>(null);
  useShortcutScope('list');
  useShortcut('list.search', () => {
    ref.current?.focus();
    ref.current?.select();
  });
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const settle = useRef(onSettle);
  useEffect(() => {
    settle.current = onSettle;
  });
  useEffect(() => () => {
    clearTimeout(timer.current);
  }, []);
  const change = (q: string) => {
    setText(q);
    setSeen(q);
    onChange(q);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      settle.current(q);
    }, 300);
  };
  return (
    <TextInput ref={ref} size="small" leadingVisual={SearchIcon} type="search" aria-label={label} placeholder="Search…" aria-keyshortcuts="/" value={text} className="ml-1 w-48 min-w-24 shrink"
      onChange={(e) => {
        change(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && text) {
          e.stopPropagation();
          change('');
        }
      }}/>
  );
}

export function SortMenu<S extends string>({value, names, onChange}: {value: S; names: Record<S, string>; onChange: (sort: S) => void}) {
  return (
    <ActionMenu>
      <ActionMenu.Anchor><Button variant="invisible" size="small" leadingVisual={ArrowSwitchIcon} type="button" aria-label={`Sort: ${names[value]}`}>Sort</Button></ActionMenu.Anchor>
      <ActionMenu.Overlay><ActionList>
        <ActionList.Group selectionVariant="single"><ActionList.GroupHeading>Sort</ActionList.GroupHeading>
        
          {(Object.keys(names) as S[]).map((s) => <ActionList.Item key={s} selected={value === s} onSelect={() => { onChange(s); }}>{names[s]}</ActionList.Item>)}
        </ActionList.Group>
      </ActionList></ActionMenu.Overlay>
    </ActionMenu>
  );
}
