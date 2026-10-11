// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Switch as S} from 'radix-ui';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name, when no <label htmlFor> names it. */
  label?: string | undefined;
  id?: string | undefined;
  disabled?: boolean | undefined;
  /** The id of the text that describes it (a setting's explanation). */
  describedBy?: string | undefined;
}

/**
 * An on/off setting that applies at once (a repository's feature): a switch role, Space toggles. The thumb
 * moves instantly (motion tokens: entering a state is instant).
 */
export function Switch({checked, onCheckedChange, label, id, disabled, describedBy}: SwitchProps) {
  return (
    <S.Root id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-label={label} aria-describedby={describedBy}
      className="interactive inline-flex h-4.5 w-8 shrink-0 items-center rounded-full border border-border-strong bg-border-strong p-px disabled:opacity-disabled data-[state=checked]:border-accent data-[state=checked]:bg-accent">
      <S.Thumb className="block size-3.5 rounded-full bg-fg-on-accent data-[state=checked]:translate-x-3.5"/>
    </S.Root>
  );
}
