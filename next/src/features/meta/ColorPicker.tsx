// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {Button, TextInput} from '@primer/react';
import {DotFillIcon} from '@primer/octicons-react';
import {normalizeColor} from './labels.ts';

export function ColorPicker({id, value, presets, invalid, onChange}: {
  id: string; value: string; presets: readonly string[]; invalid: boolean; onChange: (color: string) => void;
}) {
  return <div className="flex flex-col gap-2">
    <TextInput id={id} aria-label="Colour" value={value} monospace maxLength={7} leadingVisual="#"
      onChange={(event) => { onChange(event.target.value); }} {...(invalid ? {validationStatus: 'error' as const} : {})}/>
    <div role="group" aria-label="Preset colours" className="flex flex-wrap gap-2">
      {presets.map((color) => <Button key={color} type="button" size="small" aria-label={color}
        aria-pressed={normalizeColor(value) === color} onClick={() => { onChange(color); }}
        leadingVisual={() => <DotFillIcon fill={color}/>}>{color}</Button>)}
    </div>
  </div>;
}
