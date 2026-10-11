// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {CheckCircleIcon, XCircleIcon, ClockIcon, DotFillIcon} from '@primer/octicons-react';
import type {ReactNode} from 'react';

export type StatusTone = 'success' | 'danger' | 'warning' | 'accent' | 'muted' | 'done';
const colors = {success: 'text-success', danger: 'text-danger', warning: 'text-attention', accent: 'text-accent', muted: 'text-muted', done: 'text-done'};
export function CheckStatus({tone}: {tone: StatusTone}) {
  const Icon = tone === 'success' ? CheckCircleIcon : tone === 'danger' ? XCircleIcon : tone === 'warning' ? ClockIcon : DotFillIcon;
  return <Icon size={16} className={colors[tone]}/>;
}
export function RunStatus({tone, children}: {tone: StatusTone; children: ReactNode}) {
  return <span className="flex items-center gap-2"><CheckStatus tone={tone}/>{children}</span>;
}
