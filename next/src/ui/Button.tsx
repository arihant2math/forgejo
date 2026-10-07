// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Slot} from 'radix-ui';
import type {ButtonHTMLAttributes, ReactElement, ReactNode, Ref} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {control, controlHeight, type ControlSize} from './recipes.ts';
import {Tooltip} from './Tooltip.tsx';

const variants = {
  primary: 'bg-accent text-fg-on-accent hover:bg-accent-hover',
  secondary: 'border border-border bg-surface text-fg hover:bg-hover',
  ghost: 'text-fg-muted hover:bg-hover hover:text-fg data-[state=open]:bg-hover data-[state=open]:text-fg',
  danger: 'bg-danger-solid text-fg-on-accent hover:bg-danger-solid-hover',
} as const;

export type ButtonVariant = keyof typeof variants;

interface BaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | undefined;
  size?: ControlSize | undefined;
  /** Render the single child (e.g. a router <Link>) with the button's look instead of a <button>; `icon` is then ignored (put an <Icon> in the child). */
  asChild?: boolean | undefined;
  /** Shortcut hint shown in the tooltip, e.g. "C" or "G I". */
  shortcut?: string | undefined;
  ref?: Ref<HTMLButtonElement>;
}

export interface ButtonProps extends BaseProps {
  icon?: LucideIcon | undefined;
  /** Shown on hover/focus; also shows the shortcut. */
  tooltip?: ReactNode;
  children: ReactNode;
}

const base = cx(control, 'justify-center font-medium whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-disabled');

function withTooltip(el: ReactElement, content: ReactNode, shortcut: string | undefined) {
  return content ? <Tooltip content={content} shortcut={shortcut}>{el}</Tooltip> : el;
}

export function Button({variant = 'secondary', size = 'md', icon, tooltip, shortcut, asChild, children, className, ...rest}: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  const el = (
    <Comp
      {...(asChild ? {} : {type: 'button' as const})}
      className={cx(base, controlHeight[size], size === 'sm' ? 'gap-1 px-2 text-sm' : 'gap-1.5 px-3 text-base', variants[variant], className)}
      {...rest}
    >
      {asChild ? children : <>{icon && <Icon icon={icon} size={size}/>}{children}</>}
    </Comp>
  );
  return withTooltip(el, tooltip, shortcut);
}

export interface IconButtonProps extends Omit<BaseProps, 'asChild' | 'children'> {
  icon: LucideIcon;
  /** Accessible name, also shown as the tooltip. */
  label: string;
  /** A toggle button: exposes aria-pressed and looks selected while on. */
  pressed?: boolean | undefined;
}

/** A square icon-only button with a tooltip naming it (and its shortcut). */
export function IconButton({variant = 'ghost', size = 'md', icon, label, shortcut, pressed, className, ...rest}: IconButtonProps) {
  return withTooltip(
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      className={cx(base, size === 'sm' ? 'size-control-sm' : 'size-control', variants[variant], pressed && 'aria-pressed:bg-selected aria-pressed:text-fg', className)}
      {...rest}
    >
      <Icon icon={icon} size={size}/>
    </button>,
    label,
    shortcut,
  );
}
