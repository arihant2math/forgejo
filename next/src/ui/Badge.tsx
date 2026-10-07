// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {CSSProperties, ReactNode} from 'react';
import {cx} from './cx.ts';

const chip = 'inline-flex h-5 shrink-0 items-center gap-1 px-1.5 text-sm font-medium whitespace-nowrap tabular-nums';

const tones = {
  neutral: 'bg-hover text-fg-muted',
  accent: 'bg-accent-subtle text-accent',
  danger: 'bg-danger-subtle text-danger',
} as const;

/** A small status or count chip. */
export function Badge({tone = 'neutral', children}: {tone?: keyof typeof tones; children: ReactNode}) {
  return <span className={cx(chip, 'rounded-sm', tones[tone])}>{children}</span>;
}

/** An issue label: its own colour (server data) as a dot, the name in normal text colour. */
export function LabelChip({name, color}: {name: string; color: string}) {
  return (
    <span className={cx(chip, 'rounded-full border border-border text-fg-muted')} style={{'--label-color': color} as CSSProperties}>
      <span aria-hidden className="size-2 rounded-full bg-label"/>
      {name}
    </span>
  );
}
