// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import type {ReactNode} from 'react';
import {ClockIcon} from '@primer/octicons-react';

export function LabelListRow({children, trailing, role}: {children: ReactNode; trailing?: ReactNode; role?: 'presentation' | undefined}) {
  return <div role={role} className="flex items-center justify-between gap-4 border-b border-muted px-4 py-2 last:border-b-0">
    <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    <div className="flex shrink-0 items-center gap-2">{trailing}</div>
  </div>;
}

export function SavingIndicator({label}: {label: string}) {
  return <span title={label}><ClockIcon aria-label={label}/></span>;
}
