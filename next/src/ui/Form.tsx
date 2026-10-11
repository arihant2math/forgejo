// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The parts of a settings page (a repository's settings), besides the fields
// (Input.tsx Field): a titled section (the danger zone in red), and a row
// that names a setting on the left and holds its control on the right.

import type {ReactNode} from 'react';
import {cx} from './cx.ts';

/** The id of a setting's hint or a field's error text (what its control's aria-describedby names). */
export function hintId(id: string): string {
  return `${id}-hint`;
}

export interface FormSectionProps {
  /** Its heading's id (names the section). */
  id: string;
  title: string;
  description?: ReactNode;
  /** `danger`: irreversible actions, in a red box (GitHub's danger zone). */
  tone?: 'default' | 'danger' | undefined;
  /** Buttons at the end of the heading row (Add). */
  actions?: ReactNode;
  children: ReactNode;
}

/** A titled part of a settings page. */
export function FormSection({id, title, description, tone = 'default', actions, children}: FormSectionProps) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <header className="flex min-h-control items-end gap-2 border-b border-border pb-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 id={id} className={cx('text-md font-semibold', tone === 'danger' ? 'text-danger' : 'text-fg')}>{title}</h2>
          {description && <p className="text-sm text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {tone === 'danger' ? <div className="flex flex-col rounded-md border border-danger px-3">{children}</div> : children}
    </section>
  );
}

export interface SettingRowProps {
  /** The control's id: the title labels it, the description describes it (`hintId(id)`). */
  id: string;
  title: string;
  description?: ReactNode;
  /** The switch, checkbox or button. */
  control: ReactNode;
}

/** One setting: what it is on the left, its control on the right (a feature's switch, a danger-zone button). */
export function SettingRow({id, title, description, control}: SettingRowProps) {
  return (
    <div className="flex min-w-0 items-center gap-4 border-b border-border-subtle py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="text-base font-medium text-fg">{title}</label>
        {description && <p id={hintId(id)} className="text-sm text-fg-muted">{description}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}
