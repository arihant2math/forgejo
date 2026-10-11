// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import type {InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes} from 'react';
import {IconButton} from './Button.tsx';
import {cx} from './cx.ts';
import {Icon, type LucideIcon} from './Icon.tsx';
import {control, controlHeight, type ControlSize, field} from './recipes.ts';
import {CopyIcon} from '@primer/octicons-react';

/** A text input. It has no width of its own: size it with className (w-full, w-64). */
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: ControlSize | undefined;
  invalid?: boolean | undefined;
  /** A decorative icon inside, before the text (search). */
  icon?: LucideIcon | undefined;
  /** Code-like text (a branch pattern, a path): the monospace face. */
  mono?: boolean | undefined;
  ref?: Ref<HTMLInputElement>;
}

export function Input({size = 'md', invalid, icon, mono, className, ...rest}: InputProps) {
  const input = (
    <input
      aria-invalid={invalid}
      className={cx(
        control,
        controlHeight[size],
        field,
        'px-2',
        mono ? 'font-mono text-code' : size === 'sm' ? 'text-sm' : 'text-base',
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

/**
 * A value to copy (a clone URL): read-only and whole (a click or the focus selects all of it, monospace), with a
 * copy button after it. Full width. The caller copies (`onCopy`) and says so.
 */
export function CopyField({value, label, copyLabel, onCopy}: {value: string; label: string; copyLabel: string; onCopy: () => void}) {
  return (
    <span className="flex w-full min-w-0 items-center gap-1">
      <input readOnly value={value} aria-label={label} spellCheck={false}
        onFocus={(e) => {
          e.currentTarget.select();
        }}
        className={cx(control, controlHeight.sm, field, 'min-w-0 flex-1 px-2 font-mono text-code')}/>
      <IconButton size="sm" icon={CopyIcon} label={copyLabel} onClick={onCopy}/>
    </span>
  );
}

/** Multi-line text (markdown source: a description, a comment). Full width; grows with `rows`, resizable vertically. */
export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'style'> {
  invalid?: boolean | undefined;
  /** Inside an EditorFrame (the frame draws the box and the focus outline). */
  bare?: boolean | undefined;
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextArea({invalid, bare = false, rows = 6, ...rest}: TextAreaProps) {
  return (
    <textarea
      aria-invalid={invalid}
      rows={rows}
      // The prose size: what is typed reads like what it becomes (ProseSource, the rendering).
      className={cx('block w-full resize-y px-2 py-1.5 text-md', bare ? 'bg-transparent text-fg outline-none placeholder:text-fg-subtle' : cx('interactive rounded-md', field))}
      {...rest}
    />
  );
}

/**
 * The box of a rich text field (the CodeMirror markdown editor): a TextArea's
 * look — border, surface, hover, focus outline while the editor inside has
 * focus, invalid — around content the editor draws. Full width.
 */
export function EditorFrame({invalid, header, children, ref}: {invalid?: boolean | undefined; header?: ReactNode; children: ReactNode; ref?: Ref<HTMLDivElement>}) {
  return (
    <div ref={ref} aria-invalid={invalid} className={cx('interactive flex w-full flex-col overflow-hidden rounded-md text-md focus-ring-within', field)}>
      {children}
      {/* The field's own controls (Write / Preview, formatting): on top, inside the same box, which never moves — but
          after the text in the focus order (Linear: Tab from a title goes to the description, then the toolbar). */}
      {header && <div className="order-first flex items-center gap-1 border-b border-border-subtle px-1 py-1">{header}</div>}
    </div>
  );
}

/**
 * A heading edited in place (an issue's title): the heading's own type size, a hairline box only while
 * editing. Full width.
 */
export function TitleInput({invalid, ...rest}: Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'style' | 'size'> & {invalid?: boolean | undefined; ref?: Ref<HTMLInputElement>}) {
  return <input aria-invalid={invalid} className={cx('interactive -mx-2 block w-full rounded-md px-2 py-0.5 text-xl font-semibold', field)} {...rest}/>;
}

/** A heading that opens its editor on click (TitleInput): looks like the heading, hovers like a control. */
export function EditableHeading({label, onEdit, children}: {label: string; onEdit: () => void; children: ReactNode}) {
  return (
    <h2 className="text-xl font-semibold text-fg">
      <button type="button" title={label} onClick={onEdit} className="interactive -mx-2 w-full cursor-text rounded-md px-2 py-0.5 text-left hover:bg-hover">{children}</button>
    </h2>
  );
}

/**
 * A form's field: its name above the control (`htmlFor`: the control's id), then a hint or — once something is
 * wrong — the problem, in the danger colour (`errorId`: the control's aria-describedby).
 */
export function Field({label, htmlFor, hint, error, errorId, optional, children}: {
  label: string; htmlFor: string; hint?: ReactNode; error?: string | undefined; errorId?: string | undefined;
  /** Marked "(optional)" after the name. */
  optional?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">{label}{optional && <span className="font-normal text-fg-subtle"> (optional)</span>}</label>
      {children}
      {error ? <p id={errorId} className="text-sm text-danger">{error}</p> : hint ? <p id={errorId} className="text-sm text-fg-muted">{hint}</p> : null}
    </div>
  );
}

/** A checkbox with its label (a dialog's option). */
export function Checkbox({label, checked, onChange, disabled}: {label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean | undefined}) {
  return (
    <label className="inline-flex items-center gap-2 text-base text-fg has-disabled:opacity-disabled">
      <input type="checkbox" className="size-4 accent-accent" checked={checked} disabled={disabled} onChange={(e) => {
        onChange(e.target.checked);
      }}/>
      {label}
    </label>
  );
}
