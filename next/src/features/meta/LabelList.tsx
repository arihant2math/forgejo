// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import type {ReactNode} from 'react';
import {Heading} from '@primer/react';
import {ClockIcon} from '@primer/octicons-react';

/** Label and milestone list layout, including non-navigational rows and usage links. */
export function MetadataSection({label, title, actions, children}: {label: string; title: ReactNode; actions?: ReactNode; children: ReactNode}) {
  return <section aria-label={label} className="rounded-md border border-default">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-default bg-muted p-3">
      <Heading as="h2" variant="small">{title}</Heading>{actions}
    </header>
    {children}
  </section>;
}

export function LabelListRow({children, trailing, role}: {children: ReactNode; trailing?: ReactNode; role?: 'presentation' | undefined}) {
  return <div role={role} className="flex items-center justify-between gap-3 border-b border-muted p-3 last:border-b-0">
    <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    <div className="flex shrink-0 items-center gap-2">{trailing}</div>
  </div>;
}

export function SavingIndicator({label}: {label: string}) {
  return <span title={label}><ClockIcon aria-label={label}/></span>;
}
