// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {AriaAlert, FormControl} from '@primer/react';
import type {ReactNode} from 'react';

/**
 * A labelled form field: an error replaces the hint and is announced. FormControl wires a direct TextInput, Textarea, Select or
 * SelectPanel child to the label and messages; a control nested deeper (in a row with a button, a custom picker)
 * takes them with useFormControlForwardedProps.
 */
export function Field({id, label, required = false, optional = false, hint, error, children}: {
  id?: string | undefined; label: string; required?: boolean; optional?: boolean; hint?: ReactNode; error?: string | undefined; children: ReactNode;
}) {
  return (
    <FormControl {...(id ? {id} : {})} required={required} className="min-w-0">
      <FormControl.Label>{label}{optional ? ' (optional)' : ''}</FormControl.Label>
      {children}
      {error ? <FormControl.Validation variant="error"><AriaAlert as="span">{error}</AriaAlert></FormControl.Validation> :
        hint && <FormControl.Caption>{hint}</FormControl.Caption>}
    </FormControl>
  );
}
