// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {cx} from './cx.ts';

/** One key cap. */
export function Kbd({children, className}: {children: string; className?: string}) {
  return (
    <kbd
      className={cx(
        'inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-sm border border-border bg-canvas px-1 font-sans text-xs text-fg-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** A shortcut such as "⌘K" or a sequence such as "G I" (space-separated keys). */
export function Shortcut({keys, className}: {keys: string; className?: string}) {
  return (
    <span className={cx('inline-flex items-center gap-0.5', className)}>
      {keys.split(' ').map((key) => <Kbd key={key}>{key}</Kbd>)}
    </span>
  );
}
