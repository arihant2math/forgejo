// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {Button, TextInput, useFormControlForwardedProps} from '@primer/react';
import {DotFillIcon} from '@primer/octicons-react';
import {normalizeColor} from './labels.ts';

/** Inside a FormControl: its label and messages describe the hex field. */
export function ColorPicker({value, presets, invalid, onChange}: {
  value: string; presets: readonly string[]; invalid: boolean; onChange: (color: string) => void;
}) {
  const wiring = useFormControlForwardedProps({});
  return <div className="flex flex-col gap-2">
    <TextInput id={wiring.id} aria-describedby={wiring['aria-describedby']} value={value} monospace maxLength={7} leadingVisual="#"
      onChange={(event) => { onChange(event.target.value); }} {...(invalid ? {validationStatus: 'error' as const} : {})}/>
    <div role="group" aria-label="Preset colours" className="flex flex-wrap gap-2">
      {presets.map((color) => <Button key={color} type="button" size="small" aria-label={color}
        aria-pressed={normalizeColor(value) === color} onClick={() => { onChange(color); }}
        leadingVisual={() => <DotFillIcon fill={color}/>}>{color}</Button>)}
    </div>
  </div>;
}
