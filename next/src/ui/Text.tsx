// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Slot} from 'radix-ui';
import type {ReactNode} from 'react';

/** Inline code outside rendered markdown (a path, a branch): the same look as prose code. */
export function Code({children}: {children: ReactNode}) {
  return <code className="rounded-sm bg-hover px-1 font-mono text-sm text-fg">{children}</code>;
}

/**
 * A link in running text or a property (an issue reference, a breadcrumb): the text colour, the
 * accent on hover. Wrap a router <Link> (asChild) so it navigates in place. In a property it truncates
 * to one line; `wrap` (inside a sentence) lets it wrap with the text around it.
 */
export function TextLink({wrap = false, children}: {wrap?: boolean; children: ReactNode}) {
  return <Slot.Root className={wrap ? 'interactive text-fg hover:text-accent-fg' : 'interactive min-w-0 truncate text-fg hover:text-accent-fg'}>{children}</Slot.Root>;
}
