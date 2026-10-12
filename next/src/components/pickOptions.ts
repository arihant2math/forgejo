// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Icon} from '@primer/octicons-react';
import type {KeyboardEvent, ReactNode} from 'react';

/** Pickers with more options than this virtualize their list. */
export const VIRTUALIZE_OVER = 50;

/** One choice of a picker; selection lives in `checked` and `onSelect`, not in the panel. */
export interface PickOption {
  value: string;
  label: string;
  /** More text the filter matches (logins, descriptions, numbers). */
  words?: string | undefined;
  description?: string | undefined;
  group?: string | undefined;
  icon?: Icon | undefined;
  leading?: ReactNode;
  meta?: ReactNode;
  /** 'mixed': applied to some of several targets. */
  checked?: boolean | 'mixed' | undefined;
  disabled?: boolean | undefined;
  /** Whether picking it leaves the panel open; defaults to the panel being multi-select. */
  keepOpen?: boolean | undefined;
  onSelect: () => void;
}

/** Every typed word must occur in the label or the option's words. */
export function matchOptions(options: readonly PickOption[], query: string): readonly PickOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((option) => {
    const text = `${option.label} ${option.words ?? ''}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/**
 * Enter in a SelectPanel's filter picks the first shown option while no option is active: Primer moves the active
 * descendant only after the list re-renders, so a quick Enter after typing would otherwise do nothing. An empty filter
 * picks nothing, so Enter right after opening never changes a value by accident.
 */
export function enterPicksFirst(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
  const input = event.currentTarget;
  const active = input.getAttribute('aria-activedescendant');
  if (active && document.getElementById(active)) return;
  event.preventDefault();
  if (!input.value.trim()) return;
  const list = document.getElementById(input.getAttribute('aria-controls') ?? '') ?? input.closest('[role="dialog"]');
  list?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])')?.click();
}
