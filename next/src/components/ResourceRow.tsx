// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';
import {Text} from '@primer/react';

/** A Box-row for a thing with its own controls (a person, a key, a rule): a list item, not a link or a menu item.
 * Render it inside a `ul`; the first row leaves the separator to the box header. */
export function ResourceRow({leading, title, meta, description, actions, children}: {
  leading?: ReactNode; title?: ReactNode; meta?: ReactNode; description?: ReactNode; actions?: ReactNode;
  /** Free inline content below the title, or instead of it. */
  children?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2 border-t border-muted px-4 py-3 first:border-t-0">
      {leading && <span className="flex shrink-0 items-center text-muted">{leading}</span>}
      <div className="min-w-0 flex-1">
        {title !== undefined && <div className="flex flex-wrap items-center gap-2"><Text size="medium" weight="semibold">{title}</Text>{meta && <span className="text-sm text-muted">{meta}</span>}</div>}
        {children}
        {description && <div className="mt-1 text-sm text-muted">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-muted">{actions}</div>}
    </li>
  );
}
