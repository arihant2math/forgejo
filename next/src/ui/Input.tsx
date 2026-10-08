// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {InputHTMLAttributes, Ref} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {control, controlHeight, type ControlSize} from './recipes.ts';

/** A text input. It has no width of its own: size it with className (w-full, w-64). */
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: ControlSize | undefined;
  invalid?: boolean | undefined;
  /** A decorative icon inside, before the text (search). */
  icon?: LucideIcon | undefined;
  ref?: Ref<HTMLInputElement>;
}

export function Input({size = 'md', invalid, icon, className, ...rest}: InputProps) {
  const input = (
    <input
      aria-invalid={invalid}
      className={cx(
        control,
        controlHeight[size],
        'border border-border bg-surface px-2 text-fg placeholder:text-fg-subtle hover:border-border-strong',
        'focus-visible:outline-offset-0 aria-invalid:border-danger aria-invalid:outline-danger disabled:opacity-disabled',
        size === 'sm' ? 'text-sm' : 'text-base',
        icon ? 'w-full pl-7' : className,
      )}
      {...rest}
    />
  );
  if (!icon) return input;
  return (
    <span className={cx('relative inline-flex items-center', className)}>
      <span className="pointer-events-none absolute left-2 flex text-fg-subtle"><Icon icon={icon} size="sm"/></span>
      {input}
    </span>
  );
}
