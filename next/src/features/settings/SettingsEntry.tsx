// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Text} from '@primer/react';
import type {ReactNode} from 'react';

/** A resource row with its own controls, not a single selectable menu item. */
export function SettingsEntry({leading, title, meta, description, actions}: {leading?: ReactNode; title: ReactNode; meta?: ReactNode; description?: ReactNode; actions?: ReactNode}) {
  return <li className="flex min-w-0 flex-wrap items-center gap-2 border-t border-muted px-4 py-3 first:border-t-0">
    {leading && <span className="flex shrink-0 items-center text-muted">{leading}</span>}
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2"><Text size="medium" weight="semibold">{title}</Text>{meta && <span className="text-sm text-muted">{meta}</span>}</div>
      {description && <div className="text-sm text-muted">{description}</div>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </li>;
}
