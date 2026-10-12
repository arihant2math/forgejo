// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useState, useSyncExternalStore} from 'react';
import {useLocation} from '@tanstack/react-router';
import {useSession} from '../../app/store.ts';
import {GearIcon} from '@primer/octicons-react';
import {AnchoredOverlay, IconButton, SegmentedControl, ToggleSwitch} from '@primer/react';

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
  const [open, setOpen] = useState(false);
  return <AnchoredOverlay open={open} onOpen={() => {setOpen(true);}} onClose={() => {setOpen(false);}} align="end"
    renderAnchor={(props) => <IconButton {...props} icon={GearIcon} size="small" variant="invisible" aria-label="Diff settings"/>}>
    <div className="flex flex-col gap-4 p-4">
      <SegmentedControl size="small" aria-label="Diff layout" onChange={(index) => {s.set(index === 1, s.hide);}}>
        <SegmentedControl.Button selected={!s.split}>Unified</SegmentedControl.Button><SegmentedControl.Button selected={s.split}>Split</SegmentedControl.Button>
      </SegmentedControl>
      <div className="flex items-center gap-2"><span id="diff-whitespace-label">Hide whitespace changes</span><ToggleSwitch size="small" aria-labelledby="diff-whitespace-label" checked={s.hide} onChange={(checked) => {s.set(s.split, checked);}}/></div>
      {s.hide && <p className="text-xs text-muted">Hidden changes cannot receive line comments.</p>}
    </div>
  </AnchoredOverlay>;
}
