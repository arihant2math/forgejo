// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Slot} from 'radix-ui';
import type {ReactNode} from 'react';

/** Inline code outside rendered markdown (a path, a branch): the same look as prose code. */
export function Code({children}: {children: ReactNode}) {
  return <code className="rounded-sm bg-control-transparent-hover px-1 font-mono text-sm text-default">{children}</code>;
}

/**
 * A link in running text or a property (an issue reference, a breadcrumb): the text colour, the
 * accent on hover. Wrap a router <Link> (asChild) so it navigates in place. In a property it truncates
 * to one line; `wrap` (inside a sentence) lets it wrap with the text around it.
 */
export function TextLink({wrap = false, accent = false, children}: {wrap?: boolean; accent?: boolean; children: ReactNode}) {
  // `accent`: a reference inside text that is not otherwise a link (a commit message's "#12"): visibly a link.
  if (accent) return <Slot.Root className="interactive text-accent hover:underline">{children}</Slot.Root>;
  return <Slot.Root className={wrap ? 'interactive text-default hover:text-accent' : 'interactive min-w-0 truncate text-default hover:text-accent'}>{children}</Slot.Root>;
}
