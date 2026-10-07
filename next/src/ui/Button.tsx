// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ButtonHTMLAttributes, Ref} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {control, controlHeight, type ControlSize} from './recipes.ts';
import {Tooltip} from './Tooltip.tsx';

const variants = {
  primary: 'bg-accent text-fg-on-accent hover:bg-accent-hover',
  secondary: 'border border-border bg-surface text-fg hover:bg-hover',
  ghost: 'text-fg-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg',
  danger: 'bg-danger text-fg-on-accent hover:bg-danger/90',
} as const;

export type ButtonVariant = keyof typeof variants;

interface BaseProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ControlSize;
  ref?: Ref<HTMLButtonElement>;
}

export interface ButtonProps extends BaseProps {
  icon?: LucideIcon;
  children: string;
}

const base = cx(control, 'justify-center font-medium whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-50');

export function Button({variant = 'secondary', size = 'md', icon, children, className, type = 'button', ...rest}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(base, controlHeight[size], size === 'sm' ? 'gap-1 px-2 text-sm' : 'gap-1.5 px-3 text-base', variants[variant], className)}
      {...rest}
    >
      {icon && <Icon icon={icon} size={size}/>}
      {children}
    </button>
  );
}

export interface IconButtonProps extends BaseProps {
  icon: LucideIcon;
  /** Accessible name, also shown as the tooltip. */
  label: string;
  shortcut?: string;
}

/** A square icon-only button with a tooltip naming it (and its shortcut). */
export function IconButton({variant = 'ghost', size = 'md', icon, label, shortcut, className, type = 'button', ...rest}: IconButtonProps) {
  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        type={type}
        aria-label={label}
        className={cx(base, size === 'sm' ? 'size-control-sm' : 'size-control', variants[variant], className)}
        {...rest}
      >
        <Icon icon={icon} size={size}/>
      </button>
    </Tooltip>
  );
}
