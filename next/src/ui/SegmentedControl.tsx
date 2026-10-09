// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ToggleGroup} from 'radix-ui';
import {control, controlHeight} from './recipes.ts';
import {cx} from './cx.ts';

export interface Segment<V extends string> {
  value: V;
  label: string;
  disabled?: boolean | undefined;
}

/**
 * One choice among a few (a review's verdict): a radio group — one tab stop,
 * arrow keys move, the chosen one is filled.
 */
export function SegmentedControl<V extends string>({label, value, onChange, options}: {label: string; value: V; onChange: (v: V) => void; options: readonly Segment<V>[]}) {
  return (
    <ToggleGroup.Root type="single" aria-label={label} value={value} onValueChange={(v) => {
      if (v) onChange(v as V);
    }} className="inline-flex gap-px rounded-md border border-border p-px">
      {options.map((o) => (
        <ToggleGroup.Item key={o.value} value={o.value} disabled={o.disabled}
          className={cx(control, controlHeight.sm, 'px-2.5 text-sm text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-disabled data-[state=on]:bg-selected data-[state=on]:text-fg')}>
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
