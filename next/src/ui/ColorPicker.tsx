// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {CSSProperties} from 'react';
import {Check, Pipette} from 'lucide-react';
import {cx} from './cx.ts';
import {Icon} from './Icon.tsx';
import {Input} from './Input.tsx';
import {labelInk} from './ink.ts';

const swatchColor = (color: string) => ({'--label-color': color} as CSSProperties);

const swatch = 'interactive flex size-control-sm shrink-0 items-center justify-center rounded-md border border-border bg-label';

export interface ColorPickerProps {
  /** The colour as typed ("#e11d21"); may be incomplete while typing. */
  value: string;
  onChange: (value: string) => void;
  /** Colours offered as one click ("#rrggbb"). */
  presets: readonly string[];
  /** The field's accessible name ("Colour"). */
  label: string;
  invalid?: boolean | undefined;
  id?: string | undefined;
}

/**
 * A colour (a label's): the hex value as text, the system's colour picker behind the eyedropper square (it shows
 * the colour), and a row of presets. The text field is the value; the others write into it.
 */
export function ColorPicker({value, onChange, presets, label, invalid, id}: ColorPickerProps) {
  const hex = /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : /^#[\da-f]{3}$/i.test(value) ? value.replace(/[\da-f]/gi, '$&$&').toLowerCase() : undefined;
  const ink = hex ? labelInk(hex) : undefined;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className={cx(swatch, 'relative cursor-pointer overflow-hidden', ink === 'light' ? 'text-on-label-light' : 'text-on-label-dark')} style={swatchColor(hex ?? 'transparent')}
          title="Pick a colour">
          <Icon icon={Pipette} size="sm"/>
          {/* The system picker, over the square (invisible; the square shows its colour). */}
          <input type="color" aria-label={`${label}: pick a colour`} value={hex ?? presets[0] ?? ''} className="absolute inset-0 size-full cursor-pointer opacity-0"
            onChange={(e) => {
              onChange(e.target.value);
            }}/>
        </label>
        <Input id={id} size="sm" aria-label={label} value={value} invalid={invalid} maxLength={7} spellCheck={false} placeholder="#rrggbb" className="w-28 font-mono"
          onChange={(e) => {
            const v = e.target.value.trim();
            onChange(v && !v.startsWith('#') ? `#${v}` : v);
          }}/>
      </div>
      <div role="group" aria-label={`${label}: presets`} className="flex flex-wrap gap-1">
        {presets.map((c) => {
          const on = hex === c.toLowerCase();
          return (
            <button key={c} type="button" aria-label={c} aria-pressed={on} title={c} className={cx(swatch, labelInk(c) === 'light' ? 'text-on-label-light' : 'text-on-label-dark')}
              style={swatchColor(c)} onClick={() => {
                onChange(c);
              }}>
              {on && <Icon icon={Check} size="sm"/>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
