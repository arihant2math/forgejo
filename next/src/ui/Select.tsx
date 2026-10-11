// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ChevronDown} from 'lucide-react';
import type {SelectHTMLAttributes} from 'react';
import {cx} from './cx.ts';
import {Icon} from './Icon.tsx';
import {control, controlHeight, type ControlSize, field} from './recipes.ts';

export interface SelectOption<V extends string> {
  value: V;
  label: string;
  disabled?: boolean | undefined;
}

export interface SelectProps<V extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'value' | 'onChange' | 'className' | 'style' | 'children'> {
  value: V;
  onValueChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  size?: ControlSize | undefined;
  invalid?: boolean | undefined;
}

/**
 * One choice among a few fixed values, in a form (a collaborator's role, a webhook's content type): the
 * platform's own select (keyboard, type-ahead and the phone's picker for free), with a text field's box.
 * Choices that filter as you type (a branch, a person) are a CommandPopover instead.
 */
export function Select<V extends string>({value, onValueChange, options, size = 'md', invalid, ...rest}: SelectProps<V>) {
  return (
    <span className="relative inline-flex min-w-0 items-center">
      <select
        aria-invalid={invalid}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value as V);
        }}
        className={cx(control, controlHeight[size], field, 'min-w-0 cursor-default appearance-none pr-7 pl-2', size === 'sm' ? 'text-sm' : 'text-base')}
        {...rest}
      >
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
      <span className="pointer-events-none absolute right-2 flex text-fg-subtle"><Icon icon={ChevronDown} size="sm"/></span>
    </span>
  );
}
