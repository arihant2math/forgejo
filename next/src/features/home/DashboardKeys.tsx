// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type ReactNode, useRef} from 'react';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';

/** Page-level J/K navigation for non-virtualized lists of link rows. */
export function DashboardKeys({children}: {children: ReactNode}) {
  const root = useRef<HTMLDivElement>(null);
  useShortcutScope('list');
  const move = (delta: number) => {
    const rows = [...(root.current?.querySelectorAll<HTMLAnchorElement>('a[data-home-row][href]') ?? [])];
    if (!rows.length) return;
    const at = rows.findIndex((row) => row === document.activeElement);
    const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + delta))];
    for (const row of rows) row.removeAttribute('data-active');
    next?.setAttribute('data-active', '');
    next?.focus({preventScroll: true});
    next?.scrollIntoView({block: 'nearest'});
  };
  useShortcut('list.next', () => { move(1); });
  useShortcut('list.prev', () => { move(-1); });
  useShortcut('list.open', () => {
    const row = document.activeElement;
    if (row instanceof HTMLAnchorElement && root.current?.contains(row) && row.matches('[data-home-row]')) row.click();
  }, true, () => document.activeElement instanceof HTMLAnchorElement &&
    Boolean(root.current?.contains(document.activeElement)) && document.activeElement.matches('[data-home-row]'));
  return <div ref={root} className="contents" data-shortcuts="" onBlur={(e) => {
    if (e.target instanceof HTMLElement) e.target.removeAttribute('data-active');
  }}>{children}</div>;
}
