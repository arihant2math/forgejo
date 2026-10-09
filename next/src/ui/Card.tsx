// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode} from 'react';

/**
 * A bordered block on the page (a review comment, a composer, the merge box):
 * the one card look. `label` names it as a region.
 */
export function Card({children, label, as: Tag = 'div'}: {children: ReactNode; label?: string | undefined; as?: 'div' | 'article' | 'section'}) {
  return <Tag aria-label={label} className="flex max-w-lg flex-col gap-2 rounded-md border border-border bg-surface p-3">{children}</Tag>;
}

/**
 * A bordered section of a page with a header row (a repository's files and README, an owner's
 * repositories): `padded` gives its content the reading inset (prose); rows (ListRow) go edge to edge.
 */
export function Panel({title, actions, label, padded = false, children}: {title: ReactNode; actions?: ReactNode; label?: string | undefined; padded?: boolean; children: ReactNode}) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-surface">
      <header className="flex h-row shrink-0 items-center gap-2 border-b border-border-subtle bg-canvas px-3 text-sm text-fg-muted">
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{title}</span>
        {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
      </header>
      {padded ? <div className="min-w-0 px-6 py-4">{children}</div> : children}
    </section>
  );
}
