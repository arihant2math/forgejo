// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

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
