// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';
import {cx} from './cx.ts';

const tones = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-fg-subtle',
} as const;

export type StatusTone = keyof typeof tones;

/** A small round status marker (decorative: say the status in text next to it). */
export function StatusDot({tone}: {tone: StatusTone}) {
  return <span aria-hidden className={cx('size-2 shrink-0 rounded-full', tones[tone])}/>;
}

/** A status in words with its dot (the sync indicator): compact, muted text. */
export function Status({tone, children}: {tone: StatusTone; children: ReactNode}) {
  return (
    <span className="flex h-control-sm items-center gap-1.5 rounded-sm px-1.5 text-sm text-fg-muted">
      <StatusDot tone={tone}/>
      {children}
    </span>
  );
}
