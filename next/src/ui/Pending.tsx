// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {CloudUpload} from 'lucide-react';
import type {ReactNode} from 'react';
import {Badge} from './Badge.tsx';
import {Hint, Icon} from './Icon.tsx';

/**
 * Marks something Forgejo does not have yet (PLAN §5.4 "pending badge"). It
 * fades in only after --delay-pending: an online change confirmed sooner never
 * shows it (no flicker); offline it stays.
 */
export function PendingIcon({label}: {label: string}) {
  return (
    <span className="inline-flex animate-pending align-middle">
      <Hint label={label}><Icon icon={CloudUpload} size="sm" className="text-fg-subtle"/></Hint>
    </span>
  );
}

/** The same as a labelled badge (text not synced yet: an edit made offline). */
export function PendingBadge({label, children}: {label: string; children: ReactNode}) {
  return (
    <span className="inline-flex animate-pending">
      <Hint label={label}><Badge><Icon icon={CloudUpload} size="sm"/>{children}</Badge></Hint>
    </span>
  );
}
