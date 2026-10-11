// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Popover as P} from 'radix-ui';
import type {ComponentProps} from 'react';
import {cx} from './cx.ts';
import {EDGE_GAP, floating} from './recipes.ts';

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverClose = P.Close;

// lg: a list of long lines (file paths), never wider than the viewport.
const widths = {sm: 'w-64', md: 'w-80', lg: 'w-md max-w-popper'} as const;

export interface PopoverContentProps extends Omit<ComponentProps<typeof P.Content>, 'className' | 'style'> {
  width?: keyof typeof widths;
}

export function PopoverContent({width = 'sm', sideOffset = 4, align = 'start', ...rest}: PopoverContentProps) {
  return (
    <P.Portal>
      <P.Content sideOffset={sideOffset} align={align} collisionPadding={EDGE_GAP} className={cx(floating, 'z-popover max-h-popper overflow-y-auto p-2', widths[width])} {...rest}/>
    </P.Portal>
  );
}
