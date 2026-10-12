// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Text} from '@primer/react';
import type {ReactNode} from 'react';

export function AccountList({title, children}: {title: string; children: ReactNode}) {
  return <section className="rounded-md border border-default">
    <div className="flex min-h-10 items-center rounded-t-md bg-muted px-4 py-2"><Text as="h3" size="medium" weight="semibold">{title}</Text></div>
    <ul>{children}</ul>
  </section>;
}

export function AccountRow({leading, trailing, children}: {leading?: ReactNode; trailing?: ReactNode; children: ReactNode}) {
  return <li className="flex min-w-0 flex-wrap items-center gap-2 border-t border-muted px-4 py-3">
    {leading && <span className="flex shrink-0 items-center text-muted">{leading}</span>}
    <div className="min-w-0 flex-1">{children}</div>
    {trailing && <div className="flex flex-wrap items-center gap-2 text-sm text-muted">{trailing}</div>}
  </li>;
}
