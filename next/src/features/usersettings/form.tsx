// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {FormControl, Heading, Text} from '@primer/react';
import {type ReactNode, useId} from 'react';

export function FormSection({title, description, actions, children, id}: {title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string}) {
  const generated = useId();
  const heading = `${id ?? generated}-title`;
  return <section aria-labelledby={heading} className="flex min-w-0 flex-col gap-4">
    <header className="flex items-center gap-2 border-b border-default pb-2">
      <Heading as="h2" variant="small" id={heading} className="min-w-0 flex-1">{title}</Heading>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
    {description && <p className="-mt-2 text-sm text-muted">{description}</p>}
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

export function SettingRow({id, title, description, children, bordered = false}: {id?: string; title: string; description?: ReactNode; children: ReactNode; bordered?: boolean}) {
  const generated = useId();
  const label = `${id ?? generated}-label`;
  return <div className={`flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 ${bordered ? 'border-t border-muted px-4 py-3 first:border-t-0' : 'py-2'}`}>
    <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
      <Text id={label} size="medium" weight="semibold">{title}</Text>
      {description && <p id={`${id ?? generated}-description`} className="text-sm text-muted">{description}</p>}
    </div>
    <div className="flex shrink-0 items-center gap-2">{children}</div>
  </div>;
}

export function FormActions({note, children}: {note?: ReactNode; children: ReactNode}) {
  return <div className="flex flex-wrap items-center justify-end gap-2">
    {note && <span className="text-sm text-muted">{note}</span>}
    {children}
  </div>;
}
