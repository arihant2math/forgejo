// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {InputHTMLAttributes, Ref} from 'react';
import {cx} from './cx.ts';
import {control, controlHeight, type ControlSize} from './recipes.ts';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: ControlSize;
  invalid?: boolean;
  ref?: Ref<HTMLInputElement>;
}

export function Input({size = 'md', invalid, className, ...rest}: InputProps) {
  return (
    <input
      aria-invalid={invalid}
      className={cx(
        control,
        controlHeight[size],
        'w-full border border-border bg-surface px-2 text-fg placeholder:text-fg-subtle hover:border-border-strong',
        'focus-visible:border-accent aria-invalid:border-danger disabled:opacity-50',
        size === 'sm' ? 'text-sm' : 'text-base',
        className,
      )}
      {...rest}
    />
  );
}
