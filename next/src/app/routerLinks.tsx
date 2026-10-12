// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Link as PrimerLink, LinkButton as PrimerLinkButton, NavList} from '@primer/react';
import {createLink} from '@tanstack/react-router';
import {clsx} from 'clsx';
import type {ComponentPropsWithRef} from 'react';

export const RouterLinkButton = createLink(PrimerLinkButton);

/** Primer's Link: accent, or `muted` (GitHub's Link--muted). */
export const RouterLink = createLink(PrimerLink);

export const RouterNavItem = createLink(NavList.Item);

/** GitHub's Link--primary, which Primer React lacks: default text, accent and underlined on hover. For plain hrefs. */
export function PrimaryAnchor({className, ...props}: ComponentPropsWithRef<'a'>) {
  return <a {...props} className={clsx(className, 'text-default hover:text-accent hover:underline')}/>;
}

/** A router link with GitHub's Link--primary look (names in lists, titles of rows). */
export const PrimaryLink = createLink(PrimaryAnchor);
