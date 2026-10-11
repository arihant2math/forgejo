// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {type MouseEventHandler, type ReactNode, useRef} from 'react';
import {useShortcut, useShortcutScope} from '../../app/shortcuts/index.ts';
import {Heading, Link, Text} from '@primer/react';

/** Bordered sections for repository data and owner resources. */
export function ResourceSection({label, title, actions, children}: {label: string; title: ReactNode; actions?: ReactNode; children: ReactNode}) {
  return <section aria-label={label} className="rounded-md border border-default">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-default p-3"><Heading as="h2" variant="small">{title}</Heading>{actions}</header>
    {children}
  </section>;
}

/** Dense navigational row: file metadata and repository summaries are not menu items. */
export function DataRow({href, onClick, leading, trailing, children}: {href: string; onClick?: MouseEventHandler<HTMLAnchorElement>; leading?: ReactNode; trailing?: ReactNode; children: ReactNode}) {
  return <div className="flex min-w-0 items-center gap-2 border-b border-muted px-3 py-2">
    {leading}<Link href={href} onClick={onClick} data-resource-row="" className="min-w-0 flex-1 truncate">{children}</Link>{trailing && <div className="flex shrink-0 items-center gap-2"><Text size="small">{trailing}</Text></div>}
  </div>;
}

/** Preserve J/K and Enter for repository/file lists without making links into menu items. */
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

/** User/team resource row with secondary metadata and independent actions. */
export function PersonRow({leading, title, meta, description, actions}: {leading?: ReactNode; title: ReactNode; meta?: ReactNode; description?: ReactNode; actions?: ReactNode}) {
  return <li className="flex items-start gap-3 border-b border-muted p-3">{leading}<div className="min-w-0 flex-1"><Text weight="semibold">{title}</Text>{meta && <Text as="span" size="small" className="ml-2">{meta}</Text>}{description && <div className="mt-1 text-muted">{description}</div>}</div>{actions}</li>;
}
