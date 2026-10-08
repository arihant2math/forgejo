// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';
import {cx} from './cx.ts';

export interface EntryProps {
  /** An icon or a status before the text. */
  leading?: ReactNode;
  title: ReactNode;
  /** Muted, after the title on the same line ("#12 · dev/big"). */
  meta?: ReactNode;
  /** A second line (why, what is next). */
  description?: ReactNode;
  /** Small buttons, right-aligned. */
  actions?: ReactNode;
}

/**
 * A two-line entry in a short list inside a panel or dialog ("Unsynced
 * changes"): a title with its context, a muted explanation, actions. Long
 * lists use ListRow (fixed height, virtualized) instead.
 */
export function Entry({leading, title, meta, description, actions}: EntryProps) {
  return (
    <li className="flex items-start gap-3 border-b border-border-subtle py-2 last:border-b-0">
      {leading && <span className="flex h-control-sm shrink-0 items-center text-fg-muted">{leading}</span>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={cx('flex min-h-control-sm items-center gap-2 text-base')}>
          <span className="min-w-0 truncate text-fg">{title}</span>
          {meta && <span className="shrink-0 text-sm text-fg-subtle tabular-nums">{meta}</span>}
        </p>
        {description && <div className="text-sm text-fg-muted">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </li>
  );
}

/** The list of Entry rows. */
export function EntryList({label, children}: {label: string; children: ReactNode}) {
  return <ul aria-label={label} className="flex flex-col">{children}</ul>;
}
