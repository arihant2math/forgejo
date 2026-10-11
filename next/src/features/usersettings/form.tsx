// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The settings pages' form layout: sections, labelled fields, setting rows.
// Layout only — the controls are src/ui's (Input, TextArea, Checkbox,
// SegmentedControl, Menu). Local to this feature until the shared form
// primitives (ui Form: Field / FormSection / SettingRow, from the
// repository settings port) are on the main branch; then these give way to
// them.

import type {ReactNode} from 'react';

/** A titled part of a settings page (GitHub's settings: a heading over a hairline, then the fields). */
export function FormSection({title, description, actions, children, id}: {title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string}) {
  return (
    <section aria-labelledby={id ? `${id}-title` : undefined} className="flex min-w-0 flex-col gap-4">
      <header className="flex items-end gap-2 border-b border-border-subtle pb-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={id ? `${id}-title` : undefined} className="text-md font-semibold text-fg">{title}</h2>
          {description && <p className="text-sm text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** A labelled control: the label above, a hint or the error below (the error replaces the hint, announced). */
export function Field({id, label, hint, error, children}: {id: string; label: string; hint?: ReactNode; error?: string | undefined; children: ReactNode}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-base font-medium text-fg">{label}</label>
      {children}
      {error ?
        <p id={`${id}-error`} role="alert" className="text-sm text-danger">{error}</p> :
        hint && <p id={`${id}-hint`} className="text-sm text-fg-subtle">{hint}</p>}
    </div>
  );
}

/** The aria-describedby of a Field's control. */
export function describedBy(id: string, error: string | undefined, hint: boolean): string | undefined {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined;
}

/** A setting with its control on the right (a switch, a choice): its name and what it does on the left. */
export function SettingRow({title, description, children}: {title: string; description?: ReactNode; children: ReactNode}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">
        <span className="text-base font-medium text-fg">{title}</span>
        {description && <span className="text-sm text-fg-muted">{description}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** A form's buttons, at its end (and why they cannot be used now, before them). */
export function FormActions({note, children}: {note?: ReactNode; children: ReactNode}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {note && <span className="text-sm text-fg-subtle">{note}</span>}
      {children}
    </div>
  );
}
