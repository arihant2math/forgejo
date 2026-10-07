// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Popover as P} from 'radix-ui';
import type {ComponentProps} from 'react';
import {cx} from './cx.ts';
import {floating} from './recipes.ts';

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverClose = P.Close;

export function PopoverContent({className, sideOffset = 4, align = 'start', ...rest}: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content sideOffset={sideOffset} align={align} className={cx(floating, 'z-popover p-2', className)} {...rest}/>
    </P.Portal>
  );
}
