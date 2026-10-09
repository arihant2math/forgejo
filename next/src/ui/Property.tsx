// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {createContext, type ReactNode, type Ref, useContext, useId} from 'react';
import {cx} from './cx.ts';
import {Tooltip} from './Tooltip.tsx';

/** A list of an entity's properties (the issue sidebar). */
export function PropertyList({children}: {children: ReactNode}) {
  return <dl className="flex flex-col gap-0.5">{children}</dl>;
}

/** The id of the enclosing Property's name (its value's buttons are labelled by it). */
const NameContext = createContext<string | undefined>(undefined);

/** One property: a muted name and its value. */
export function Property({label, children}: {label: string; children: ReactNode}) {
  const id = useId();
  return (
    <div className="flex min-h-control items-start gap-2">
      <dt id={id} className="flex h-control w-20 shrink-0 items-center text-sm text-fg-subtle">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-col"><NameContext value={id}>{children}</NameContext></dd>
    </div>
  );
}

export interface PropertyButtonProps {
  onClick: () => void;
  /** What clicking does ("Change labels"): the tooltip, with the shortcut. The accessible name is the property's name and the value. */
  label: string;
  shortcut?: string | undefined;
  disabled?: boolean | undefined;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** A property's value that opens its editor (a picker): full width, wraps its content (label chips). */
export function PropertyButton({onClick, label, shortcut, disabled, children, ref}: PropertyButtonProps) {
  const name = useContext(NameContext);
  const id = useId();
  return (
    // To the side: below, it would cover the next property (and take its first click).
    <Tooltip content={label} shortcut={shortcut} side="left">
      <button
        ref={ref}
        id={id}
        type="button"
        aria-haspopup="dialog"
        aria-labelledby={name ? `${name} ${id}` : undefined}
        disabled={disabled}
        onClick={onClick}
        className="interactive flex min-h-control w-full flex-wrap items-center gap-1 rounded-md px-2 py-1 text-left text-base text-fg hover:bg-hover disabled:pointer-events-none disabled:opacity-disabled"
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** A property without a value ("None"), muted. */
export function PropertyEmpty({children}: {children: string}) {
  return <span className="text-fg-subtle">{children}</span>;
}

const valueTones = {default: 'text-fg', muted: 'text-fg-muted', danger: 'text-danger'} as const;

/** A read-only value (projects, dependencies, dates): lined up with PropertyButton's content. */
export function PropertyValue({tone = 'default', title, children}: {tone?: 'default' | 'muted' | 'danger'; title?: string | undefined; children: ReactNode}) {
  return <span title={title} className={cx('flex min-h-control min-w-0 flex-col justify-center gap-1 px-2 py-1 text-base', valueTones[tone])}>{children}</span>;
}
