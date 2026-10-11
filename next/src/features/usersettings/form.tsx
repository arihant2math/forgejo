// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {FormControl, Heading, Text} from '@primer/react';
import {type ReactNode, useId} from 'react';

/** Settings sections compose Primer headings and form controls, with layout only. */
export function FormSection({title, description, actions, children, id}: {title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string}) {
  const generated = useId();
  const heading = `${id ?? generated}-title`;
  return <section aria-labelledby={heading} className="flex min-w-0 flex-col gap-4">
    <header className="flex items-end gap-2 border-b border-default pb-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Heading as="h2" variant="medium" id={heading}>{title}</Heading>
        {description && <Text as="p" size="small">{description}</Text>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
    {children}
  </section>;
}

export function Field({id, label, hint, error, children}: {id: string; label: string; hint?: ReactNode; error?: string | undefined; children: ReactNode}) {
  return <FormControl id={id}>
    <FormControl.Label>{label}</FormControl.Label>
    {children}
    {error ? <FormControl.Validation id={`${id}-error`} variant="error">{error}</FormControl.Validation> :
      hint && <FormControl.Caption id={`${id}-hint`}>{hint}</FormControl.Caption>}
  </FormControl>;
}

export function describedBy(id: string, error: string | undefined, hint: boolean): string | undefined {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined;
}

export function SettingRow({id, title, description, children}: {id?: string; title: string; description?: ReactNode; children: ReactNode}) {
  const generated = useId();
  const label = `${id ?? generated}-label`;
  return <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 py-2">
    <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
      <Text id={label} weight="semibold">{title}</Text>
      {description && <Text as="p" id={`${id ?? generated}-description`} size="small">{description}</Text>}
    </div>
    <div className="flex shrink-0 items-center gap-2">{children}</div>
  </div>;
}

export function FormActions({note, children}: {note?: ReactNode; children: ReactNode}) {
  return <div className="flex flex-wrap items-center justify-end gap-2">
    {note && <Text size="small">{note}</Text>}
    {children}
  </div>;
}
