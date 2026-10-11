// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A page's side pane in sections (a repository's About, Releases, Languages):
// a heading with an optional count, hairlines between the sections, compact
// icon + count + label links, and a share bar with its legend.

import {Slot} from 'radix-ui';
import {type ReactElement, type ReactNode, useId} from 'react';
import {Badge} from './Badge.tsx';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';

/** One section of a side pane: its heading (text, or a link to the section's page) and count; a hairline above all but the first. */
export function AsideSection({title, count, children}: {title: ReactNode; count?: number | undefined; children: ReactNode}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3 border-t border-border py-4 first:border-t-0 first:pt-0">
      <h2 className="flex min-w-0 items-center gap-2 text-md font-semibold text-fg">
        <span id={id} className="flex min-w-0">{title}</span>
        {count !== undefined && <Badge round>{count}</Badge>}
      </h2>
      {children}
    </section>
  );
}

/** The links of a section, one per line (AsideLink). */
export function AsideLinks({label, children}: {label?: string | undefined; children: ReactNode}) {
  return <ul aria-label={label} className="flex min-w-0 flex-col gap-2">{children}</ul>;
}

const linkTones = {
  muted: 'text-fg-muted hover:text-accent-fg',
  accent: 'font-semibold text-accent-fg hover:underline',
} as const;

/**
 * One line of a section: a muted icon, an optional bold count and the label, the whole line a link. `children` is
 * the anchor (or router <Link>) with the label inside: it takes the look, and the icon and count go in front.
 */
export function AsideLink({icon, count, tone = 'muted', children}: {icon: LucideIcon; count?: number | undefined; tone?: keyof typeof linkTones; children: ReactElement}) {
  return (
    <li className="flex min-w-0">
      <Slot.Root className={cx('interactive group flex min-w-0 items-center gap-2 text-base', linkTones[tone])}>
        <Icon icon={icon} size="sm"/>
        {count !== undefined && <span className="font-semibold text-fg tabular-nums group-hover:text-accent-fg">{count}</span>}
        <Slot.Slottable>{children}</Slot.Slottable>
      </Slot.Root>
    </li>
  );
}

/** A share's colour: one of the categorical series slots (in this order), or the neutral "the rest". */
export type ShareTone = 1 | 2 | 3 | 4 | 5 | 'other';

const fills: Record<ShareTone, string> = {
  1: 'bg-series-1', 2: 'bg-series-2', 3: 'bg-series-3', 4: 'bg-series-4', 5: 'bg-series-5', other: 'bg-fg-subtle',
};

export interface Share {
  label: string;
  value: number;
  tone: ShareTone;
}

/** A value's share of the total, for people: "42.1%", "<0.1%". */
export function percent(value: number, total: number): string {
  if (total <= 0) return '0%';
  const p = (value / total) * 100;
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p.toFixed(1)}%`;
}

/**
 * A whole split into shares (a repository's languages): a thin bar of coloured segments (2px gaps; each names
 * itself on hover) over a legend with every share's name and percentage, so no share is told by its colour alone.
 */
export function ShareBar({label, shares}: {label: string; shares: readonly Share[]}) {
  const total = shares.reduce((n, s) => n + s.value, 0);
  return (
    <figure aria-label={label} className="flex min-w-0 flex-col gap-2">
      <div aria-hidden className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        {shares.map((s) => (
          <span key={s.label} title={`${s.label} ${percent(s.value, total)}`} className={cx('block h-full min-w-0.5 basis-0', fills[s.tone])} style={{flexGrow: s.value}}/>
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {shares.map((s) => (
          <li key={s.label} className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className={cx('size-2 shrink-0 rounded-full', fills[s.tone])}/>
            <span className="font-semibold text-fg">{s.label}</span>
            <span className="text-fg-muted tabular-nums">{percent(s.value, total)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
