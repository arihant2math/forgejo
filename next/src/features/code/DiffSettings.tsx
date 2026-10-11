// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useSyncExternalStore} from 'react';
import {useLocation} from '@tanstack/react-router';
import {useSession} from '../../app/store.ts';
import {Checkbox, Popover, PopoverContent, PopoverTrigger, SegmentedControl} from '../../ui/index.ts';
import {GearIcon} from '@primer/octicons-react';
import {IconButton} from '@primer/react';

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function useDiffSettings() {
  const {userId} = useSession();
  useLocation({select: (l) => l.searchStr});
  const key = `forgejo-next:diff:${String(userId)}`;
  const saved = useSyncExternalStore(subscribe, () => {
    try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
  });
  const [layout, whitespace] = saved.split(':');
  const w = new URLSearchParams(window.location.search).get('w');
  const split = layout === 'split';
  const hide = w === '1' || (w !== '0' && whitespace === 'hide');
  return {split, hide, whitespace: hide ? 'ignore-all' : '', set: (nextSplit: boolean, nextHide: boolean) => {
    try { localStorage.setItem(key, `${nextSplit ? 'split' : 'unified'}:${nextHide ? 'hide' : 'show'}`); } catch { /* Storage may be disabled. */ }
    // Once changed explicitly, the control takes over from a shared ?w=1 link.
    const url = new URL(window.location.href);
    if (url.searchParams.has('w')) {
      url.searchParams.delete('w');
      window.history.replaceState(window.history.state, '', url);
    }
    for (const fn of listeners) fn();
  }};
}

export function DiffSettings() {
  const s = useDiffSettings();
  return <Popover>
    <PopoverTrigger asChild><IconButton icon={GearIcon} variant="invisible" aria-label="Diff settings" type="button"/></PopoverTrigger>
    <PopoverContent align="end">
      <div className="flex flex-col gap-3 p-3">
        <SegmentedControl label="Diff layout" value={s.split ? 'split' : 'unified'} options={[{value: 'unified', label: 'Unified'}, {value: 'split', label: 'Split'}]} onChange={(v) => { s.set(v === 'split', s.hide); }}/>
        <Checkbox label="Hide whitespace changes" checked={s.hide} onChange={(v) => { s.set(s.split, v); }}/>
        {s.hide && <p className="text-xs text-fg-muted">Hidden changes cannot receive line comments.</p>}
      </div>
    </PopoverContent>
  </Popover>;
}
