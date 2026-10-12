// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Breadcrumbs} from '@primer/react';
import {Link, type LinkComponentProps, type LinkProps} from '@tanstack/react-router';

export interface Crumb {
  label: string;
  /** Router destination; a crumb without one is the current page, as text. */
  link?: LinkProps | undefined;
}

/** Primer renders folded crumbs as menu items `as` the crumb's component, so it must be a plain router anchor. */
function RouterAnchor(props: LinkComponentProps) {
  return <Link {...props}/>;
}

// Exact matching marks only the crumb of this very page as current, never its ancestors.
const EXACT = {exact: true, includeSearch: false} as const;

/**
 * Primer's breadcrumbs (a list, slash separators, aria-current) with router links.
 * `menu-with-root` keeps the root and the last crumbs and folds the middle into a menu. Primer folds by count, not width: with a root,
 * a trail of four or more crumbs folds even when it would fit (GitHub's path header folds only when short of room).
 */
export function Crumbs({crumbs, overflow = 'wrap'}: {crumbs: readonly Crumb[]; overflow?: 'wrap' | 'menu-with-root'}) {
  return (
    <Breadcrumbs overflow={overflow}>
      {crumbs.map((c, i) => (c.link ?
        <Breadcrumbs.Item key={`${String(i)}:${c.label}`} as={RouterAnchor} {...c.link} activeOptions={EXACT} activeProps={{}}>{c.label}</Breadcrumbs.Item> :
        <Breadcrumbs.Item key={`${String(i)}:${c.label}`} as="span" selected>{c.label}</Breadcrumbs.Item>))}
    </Breadcrumbs>
  );
}
