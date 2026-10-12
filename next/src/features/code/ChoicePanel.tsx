// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {SelectPanel, type ButtonProps, type SelectPanelItemInput, type SelectPanelProps} from '@primer/react';
import {cloneElement, type ElementType, type ReactElement, type ReactNode, useState} from 'react';

export interface CodeChoice {
  value: string;
  label: string;
  group?: string;
  words?: string | undefined;
  meta?: string | undefined;
  icon?: ElementType;
  leading?: ReactNode;
  checked?: boolean;
  onSelect: () => void;
}

export function ChoicePanel({title, subtitle, placeholder, empty = 'No matches on this device.', choices, anchor, multiple = false, query: controlledQuery, onQueryChange, onOpenChange, footer}: {
  title: string; placeholder: string; empty?: string; choices: CodeChoice[];
  anchor: ReactElement<ButtonProps>; multiple?: boolean;
  query?: string; onQueryChange?: (query: string) => void; onOpenChange?: (open: boolean) => void;
  subtitle?: ReactElement | undefined;
  footer?: SelectPanelProps['secondaryAction'];
}) {
  const [open, setOpen] = useState(false);
  const [ownQuery, setQuery] = useState('');
  const query = controlledQuery ?? ownQuery;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) { setQuery(''); onQueryChange?.(''); }
    onOpenChange?.(next);
  };
  const items = choices.map((choice) => ({
    id: choice.value, text: choice.label,
    ...(choice.group ? choices.length > 50 ? {description: choice.group, descriptionVariant: 'inline' as const} : {groupId: choice.group} : {}),
    ...(choice.meta ? {trailingVisual: choice.meta} : {}),
    ...(choice.leading ? {leadingVisual: () => choice.leading} : choice.icon ? {leadingVisual: choice.icon} : {}),
  }));
  const visible = items.filter((item, i) => `${item.text} ${choices[i]?.words ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const selected = items.filter((_, i) => choices[i]?.checked);
  const groups = [...new Set(choices.map((choice) => choice.group).filter((group) => group !== undefined))];
  const select = (id: string | number | undefined) => { choices.find((choice) => choice.value === id)?.onSelect(); };
  return <SelectPanel title={title} aria-label={title} inputLabel={title} placeholderText={placeholder} {...(subtitle ? {subtitle} : {})} {...(footer ? {secondaryAction: footer} : {})}
    open={open} onOpenChange={changeOpen} filterValue={query} onFilterChange={(value) => { setQuery(value); onQueryChange?.(value); }}
    items={visible} {...(groups.length && choices.length <= 50 ? {groupMetadata: groups.map((group) => ({groupId: group, header: {title: group}}))} : {})}
    loading={false} setInitialFocus focusPrependedElements virtualized={items.length > 50} width="medium"
    {...(visible.length ? {} : {message: {title: empty, body: '', variant: 'empty' as const}})}
    textInputProps={{onKeyDown: (event) => {
      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
      const active = event.currentTarget.getAttribute('aria-activedescendant');
      if (active && document.getElementById(active)) return;
      // Primer selects an active descendant on keypress. Preserve Enter-on-the-first-match
      // while a filtered list has not yet acquired one (including immediately after opening).
      event.preventDefault();
      if (visible[0]) { select(visible[0].id); if (!multiple) changeOpen(false); }
    }}}
    renderAnchor={(props) => cloneElement(anchor, {...props, children: anchor.props.children})}
    {...(multiple ? {
      selected,
      onSelectedChange: (next: SelectPanelItemInput[]) => {
        const changed = items.find((item) => next.some((n) => n.id === item.id) !== selected.some((s) => s.id === item.id));
        if (changed) select(changed.id);
      },
    } : {
      selected: selected[0],
      onSelectedChange: (next: SelectPanelItemInput | undefined) => { if (next) select(next.id); changeOpen(false); },
    })}/>;
}
