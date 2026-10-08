// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes} from 'react';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {control, controlHeight, type ControlSize, field} from './recipes.ts';

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
        field,
        'px-2',
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

/** Multi-line text (markdown source: a description, a comment). Full width; grows with `rows`, resizable vertically. */
export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'style'> {
  invalid?: boolean | undefined;
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextArea({invalid, rows = 6, ...rest}: TextAreaProps) {
  return (
    <textarea
      aria-invalid={invalid}
      rows={rows}
      // The prose size: what is typed reads like what it becomes (ProseSource, the rendering).
      className={cx('interactive block w-full resize-y rounded-md px-2 py-1.5 text-md', field)}
      {...rest}
    />
  );
}

/**
 * The box of a rich text field (the CodeMirror markdown editor): a TextArea's
 * look — border, surface, hover, focus outline while the editor inside has
 * focus, invalid — around content the editor draws. Full width.
 */
export function EditorFrame({invalid, children, ref}: {invalid?: boolean | undefined; children: ReactNode; ref?: Ref<HTMLDivElement>}) {
  return (
    <div ref={ref} aria-invalid={invalid} className={cx('interactive block w-full rounded-md text-md focus-ring-within', field)}>
      {children}
    </div>
  );
}
