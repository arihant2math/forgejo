// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Popover as P} from 'radix-ui';
import type {ComponentProps} from 'react';
import {cx} from './cx.ts';
import {floating} from './recipes.ts';

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverClose = P.Close;

const widths = {sm: 'w-64', md: 'w-80'} as const;

export interface PopoverContentProps extends Omit<ComponentProps<typeof P.Content>, 'className'> {
  width?: keyof typeof widths;
}

export function PopoverContent({width = 'sm', sideOffset = 4, align = 'start', ...rest}: PopoverContentProps) {
  return (
    <P.Portal>
      <P.Content sideOffset={sideOffset} align={align} className={cx(floating, 'z-popover p-2', widths[width])} {...rest}/>
    </P.Portal>
  );
}
