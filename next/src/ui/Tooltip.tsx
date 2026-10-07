// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Tooltip as T} from 'radix-ui';
import type {ReactElement, ReactNode} from 'react';
import {Shortcut} from './Kbd.tsx';
import {floating} from './recipes.ts';
import {cx} from './cx.ts';

/** Mount once at the app root: one shared delay timer, so moving across a toolbar is instant. */
export function TooltipProvider({children}: {children: ReactNode}) {
  return <T.Provider delayDuration={500} skipDelayDuration={300}>{children}</T.Provider>;
}

export interface TooltipProps {
  content: ReactNode;
  /** Shortcut hint, e.g. "C" or "G I". */
  shortcut?: string | undefined;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** The trigger: a single element that accepts a ref (e.g. a Button). */
  children: ReactElement;
}

export function Tooltip({content, shortcut, side = 'bottom', children}: TooltipProps) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          className={cx(floating, 'z-tooltip flex max-w-xs items-center gap-2 px-2 py-1 text-sm')}
        >
          {content}
          {shortcut && <Shortcut keys={shortcut}/>}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
