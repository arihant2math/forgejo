// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useEffect, useEffectEvent, useRef, useState} from 'react';
import {useShortcut} from '../../app/shortcuts/index.ts';
import {SearchIcon} from '@primer/octicons-react';
import {TextInput} from '@primer/react';

/**
 * A page's search box, focused by the list.search shortcut. onChange runs per keystroke; onSettle once typing
 * pauses (callers update the URL there). With toList, ArrowDown and Enter move into the page's list; grow lets
 * it take the toolbar's free width.
 */
export function SearchField({value, label, onChange, onSettle, toList = false, grow = false}: {
  value: string; label: string; onChange: (q: string) => void; onSettle: (q: string) => void; toList?: boolean; grow?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useShortcut('list.search', () => {
    ref.current?.focus();
    ref.current?.select();
  });
  const [text, setText] = useState(value);
  // Only a changed value resets the text: the labels and milestones pages pass the URL's value, which lags typing.
  // A value that only catches up with the last settled text keeps what was typed since.
  const [seen, setSeen] = useState(value);
  const [settled, setSettled] = useState<string>();
  if (value !== seen) {
    setSeen(value);
    if (value === settled) setSettled(undefined);
    else setText(value);
  }
  // A fresh object per keystroke restarts the debounce even when the text returns to an earlier value.
  const [typed, setTyped] = useState<{q: string}>();
  const settle = useEffectEvent((q: string) => {
    onSettle(q);
  });
  useEffect(() => {
    if (!typed) return undefined;
    const timer = setTimeout(() => {
      setSettled(typed.q);
      settle(typed.q);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [typed]);
  const change = (q: string) => {
    setText(q);
    onChange(q);
    setTyped({q});
  };
  return (
    <TextInput ref={ref} size="small" leadingVisual={SearchIcon} type="search" aria-label={label} placeholder="Search…" aria-keyshortcuts="/" value={text} className={grow ? 'w-48 min-w-20 flex-1' : 'w-48 min-w-20 shrink'}
      onChange={(e) => {
        change(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && text) {
          e.stopPropagation();
          change('');
        } else if (toList && (e.key === 'ArrowDown' || e.key === 'Enter')) {
          const list = document.querySelector<HTMLElement>('main [role="listbox"]');
          if (!list) return;
          e.preventDefault();
          list.focus();
          if (e.key === 'Enter') list.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
        }
      }}/>
  );
}
