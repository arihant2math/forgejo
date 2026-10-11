// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {Icon} from '@primer/octicons-react';
import type {SelectPanelItemInput} from '@primer/react';
import type {ReactNode} from 'react';

/** Domain choices shared by issue editing and list filters. */
export interface PickOption {
  value: string;
  label: string;
  words?: string | undefined;
  group?: string | undefined;
  icon?: Icon | undefined;
  leading?: ReactNode;
  meta?: ReactNode;
  checked?: boolean | 'mixed' | undefined;
  keepOpen?: boolean | undefined;
  onSelect: () => void;
}

export function matchOptions(options: readonly PickOption[], query: string): readonly PickOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return options.filter((option) => words.every((word) => `${option.label} ${option.words ?? ''}`.toLowerCase().includes(word)));
}

/** Primer items keep selection distinct from the keyboard's active descendant. */
export function panelItems(options: readonly PickOption[], onClose: () => void): SelectPanelItemInput[] {
  return options.map((option) => ({
    id: option.value,
    text: option.label,
    groupId: option.group ?? 'choices',
    ...(option.leading ? {leadingVisual: () => <>{option.leading}</>} : option.icon ? {leadingVisual: option.icon} : {}),
    ...(option.meta ? {trailingVisual: option.meta} : {}),
    ...(option.checked === 'mixed' ? {description: 'Applied to some issues'} : option.group ? {description: option.group} : {}),
    onAction: (_, event) => {
      // These issue actions apply immediately, including when a selection is mixed.
      event.preventDefault();
      option.onSelect();
      if (!option.keepOpen) onClose();
    },
  }));
}

export function panelGroups(options: readonly PickOption[]) {
  return [...new Set(options.map((option) => option.group))]
    .map((group) => ({groupId: group ?? 'choices', header: {title: group ?? 'Choices'}}));
}

export function selectedItems(options: readonly PickOption[], items: SelectPanelItemInput[]) {
  return items.filter((item) => options.some((option) => option.value === item.id && option.checked === true));
}
