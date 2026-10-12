// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type MouseEventHandler, type ReactNode, useRef} from 'react';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {Text} from '@primer/react';
import {clsx} from 'clsx';
import {PrimaryAnchor} from '../../app/routerLinks.tsx';

export function ResourceSection({label, title, actions, children}: {label: string; title: ReactNode; actions?: ReactNode; children: ReactNode}) {
  return <section aria-label={label} className="rounded-md border border-default overflow-hidden">
    <header className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-default bg-muted px-4 py-2"><Text as="h2" size="medium" weight="semibold"><span className="flex items-center gap-2">{title}</span></Text>{actions}</header>
    {children}
  </section>;
}

export function DataRow({href, onClick, leading, trailing, children, compact = false}: {href: string; onClick?: MouseEventHandler<HTMLAnchorElement>; leading?: ReactNode; trailing?: ReactNode; children: ReactNode; compact?: boolean}) {
  return <div className={clsx("flex min-w-0 items-center gap-2 border-b border-muted px-4 last:border-b-0", compact ? "h-row" : "py-2")}>
    <span className="flex shrink-0 items-center text-muted">{leading}</span><PrimaryAnchor href={href} onClick={onClick} data-resource-row="" className="min-w-0 flex-1 truncate text-base">{children}</PrimaryAnchor>{trailing && <div className="flex shrink-0 items-center gap-2 text-sm text-muted">{trailing}</div>}
  </div>;
}

/** J/K and Enter navigation without turning links into menu items. */
export function ResourceRows({children}: {children: ReactNode}) {
  const root = useRef<HTMLDivElement>(null);
  useShortcutScope('list');
  const move = (delta: number) => {
    const rows = [...(root.current?.querySelectorAll<HTMLAnchorElement>('a[data-resource-row]') ?? [])];
    const at = rows.findIndex((row) => row === document.activeElement);
    const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + delta))];
    next?.focus({preventScroll: true});
    next?.scrollIntoView({block: 'nearest'});
  };
  const active = () => document.activeElement instanceof HTMLAnchorElement && Boolean(root.current?.contains(document.activeElement)) && document.activeElement.matches('[data-resource-row]');
  useShortcut('list.next', () => { move(1); });
  useShortcut('list.prev', () => { move(-1); });
  useShortcut('list.open', () => { if (active()) (document.activeElement as HTMLAnchorElement).click(); }, true, active);
  return <div ref={root} data-shortcuts="">{children}</div>;
}

export function PersonRow({leading, title, meta, description, actions}: {leading?: ReactNode; title: ReactNode; meta?: ReactNode; description?: ReactNode; actions?: ReactNode}) {
  return <li className="flex items-center gap-2 border-b border-muted px-4 py-3 last:border-b-0">{leading}<div className="min-w-0 flex-1"><Text weight="semibold">{title}</Text>{meta && <span className="ml-2 text-sm text-muted">{meta}</span>}{description && <div className="mt-1 text-muted">{description}</div>}</div>{actions}</li>;
}
