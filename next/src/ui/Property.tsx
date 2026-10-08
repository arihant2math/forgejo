// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ReactNode, Ref} from 'react';
import {Tooltip} from './Tooltip.tsx';

/** A list of an entity's properties (the issue sidebar). */
export function PropertyList({children}: {children: ReactNode}) {
  return <dl className="flex flex-col gap-0.5">{children}</dl>;
}

/** One property: a muted name and its value. */
export function Property({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className="flex min-h-control items-start gap-2">
      <dt className="flex h-control w-24 shrink-0 items-center text-sm text-fg-subtle">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-col">{children}</dd>
    </div>
  );
}

export interface PropertyButtonProps {
  onClick: () => void;
  /** Says what clicking does ("Change labels"); with the shortcut in the tooltip. */
  label: string;
  shortcut?: string | undefined;
  disabled?: boolean | undefined;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/** A property's value that opens its editor (a picker): full width, wraps its content (label chips). */
export function PropertyButton({onClick, label, shortcut, disabled, children, ref}: PropertyButtonProps) {
  return (
    <Tooltip content={label} shortcut={shortcut} side="left">
      <button
        ref={ref}
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="interactive flex min-h-control w-full flex-wrap items-center gap-1 rounded-md px-2 py-1 text-left text-base text-fg hover:bg-hover disabled:pointer-events-none"
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

/** A read-only value (projects, dependencies, dates): lined up with PropertyButton's content. */
export function PropertyValue({tone = 'default', title, children}: {tone?: 'default' | 'muted' | 'danger'; title?: string | undefined; children: ReactNode}) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'muted' ? 'text-fg-muted' : 'text-fg';
  return <span title={title} className={`flex min-h-control min-w-0 flex-col justify-center gap-1 px-2 py-1 text-base ${color}`}>{children}</span>;
}
