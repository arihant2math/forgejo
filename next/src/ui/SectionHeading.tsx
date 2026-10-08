// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {sectionLabel} from './recipes.ts';

/** A small muted heading over a group of rows inside a page or dialog. */
export function SectionHeading({children, id}: {children: string; id?: string | undefined}) {
  return <h3 id={id} className={sectionLabel}>{children}</h3>;
}
