// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';
import {cx} from './cx.ts';
import {ghostHover} from './recipes.ts';

const tones = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-fg-subtle',
  accent: 'bg-accent',
} as const;

export type StatusTone = keyof typeof tones;

/** A small round status marker (decorative: say the status in text next to it). `off`: keeps its place, not drawn (rows line up). */
export function StatusDot({tone, off = false}: {tone: StatusTone; off?: boolean}) {
  // inline-block: sized wherever it is put (an inline span, a flex row).
  return <span aria-hidden className={cx('inline-block size-2 shrink-0 rounded-full', tones[tone], off && 'invisible')}/>;
}

const status = 'flex h-control-sm items-center gap-1.5 rounded-sm px-1.5 text-sm';

/**
 * A status in words with its dot (the sync indicator): compact, muted text.
 * With `onClick` it is a button (opening the details), hovered like a ghost button.
 */
export function Status({tone, children, onClick, label}: {tone: StatusTone; children: ReactNode; onClick?: (() => void) | undefined; label?: string | undefined}) {
  if (onClick) {
    return (
      <button type="button" aria-label={label} onClick={onClick} className={cx(status, 'interactive', ghostHover)}>
        <StatusDot tone={tone}/>
        {children}
      </button>
    );
  }
  return (
    <span className={cx(status, 'text-fg-muted')}>
      <StatusDot tone={tone}/>
      {children}
    </span>
  );
}
