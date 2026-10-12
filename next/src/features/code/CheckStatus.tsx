// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {CheckCircleFillIcon, ClockIcon, DotFillIcon, SkipIcon, StopIcon, XCircleFillIcon} from '@primer/octicons-react';
import {CHECK_SUMMARY, type ChecksSummary} from '../pull/checks.ts';
import type {ReactNode} from 'react';

export type StatusTone = 'success' | 'danger' | 'warning' | 'running' | 'cancelled' | 'skipped' | 'muted';

/** GitHub Actions' status glyphs. */
const LOOK = {
  success: [CheckCircleFillIcon, 'text-success'],
  danger: [XCircleFillIcon, 'text-danger'],
  warning: [ClockIcon, 'text-attention'],
  running: [DotFillIcon, 'text-attention'],
  cancelled: [StopIcon, 'text-muted'],
  skipped: [SkipIcon, 'text-muted'],
  muted: [DotFillIcon, 'text-muted'],
} as const;

export function CheckStatus(props: {tone: StatusTone; summary?: never} | {summary: ChecksSummary; tone?: never}) {
  const [Icon, color] = props.summary !== undefined ? [CHECK_SUMMARY[props.summary].icon, CHECK_SUMMARY[props.summary].tone] : LOOK[props.tone];
  return <Icon size={16} className={color}/>;
}

export function RunStatus({tone, children}: {tone: StatusTone; children: ReactNode}) {
  return <span className="flex items-center gap-2 text-base font-normal text-muted"><CheckStatus tone={tone}/>{children}</span>;
}
