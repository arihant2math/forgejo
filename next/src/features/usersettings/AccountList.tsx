// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Heading} from '@primer/react';
import type {ReactNode} from 'react';

export function AccountList({title, children}: {title: string; children: ReactNode}) {
  return <section className="rounded-md border border-default">
    <div className="border-b border-default p-3"><Heading as="h3" variant="small">{title}</Heading></div>
    <ul>{children}</ul>
  </section>;
}

export function AccountRow({leading, trailing, children}: {leading?: ReactNode; trailing?: ReactNode; children: ReactNode}) {
  return <li className="flex min-w-0 flex-wrap items-center gap-3 border-b border-default p-3 last:border-b-0">
    {leading && <span className="shrink-0">{leading}</span>}
    <div className="min-w-0 flex-1">{children}</div>
    {trailing && <div className="flex flex-wrap items-center gap-2">{trailing}</div>}
  </li>;
}
