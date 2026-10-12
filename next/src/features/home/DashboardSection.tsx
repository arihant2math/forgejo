// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';
import {Text} from '@primer/react';

/** A bordered data section; its body holds contained rows or an activity chart. */
export function DashboardSection({title, actions, label, padded = false, children}: {
  title: ReactNode; actions?: ReactNode; label?: string | undefined; padded?: boolean; children: ReactNode;
}) {
  return <section aria-label={label} className="min-w-0 overflow-hidden rounded-md border border-default bg-default">
    <header className="flex min-h-10 items-center gap-2 border-b border-default bg-muted px-4 py-2">
      <div className="min-w-0 flex-1"><Text as="h2" size="medium" weight="semibold"><span className="flex items-center gap-2">{title}</span></Text></div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
    {padded ? <div className="min-w-0 p-4">{children}</div> : children}
  </section>;
}
