// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {SelectPanel, type SelectPanelItemInput, type SelectPanelProps} from '@primer/react';
import {observer} from 'mobx-react-lite';
import {type HTMLAttributes, type ReactElement, type RefObject, useState} from 'react';
import {enterPicksFirst, matchOptions, type PickOption, VIRTUALIZE_OVER} from './pickOptions.ts';

type PrimerAnchorProps = Omit<HTMLAttributes<HTMLElement>, 'aria-label' | 'aria-labelledby'>;
/** Primer's anchor props (ref, id, aria-expanded, handlers): no className or style, so they spread as they are. */
export type AnchorProps = Omit<PrimerAnchorProps, 'children'> & {children?: undefined};
type Gesture = Parameters<SelectPanelProps['onOpenChange']>[1];

export type LocalSelectPanelProps = {
  title: string;
  subtitle?: string | ReactElement | undefined;
  placeholder: string;
  inputLabel?: string | undefined;
  /** A function is called only while the panel is open, for options that are costly to build. */
  options: readonly PickOption[] | (() => readonly PickOption[]);
  multiple?: boolean | undefined;
  /** The options already match the query (searched or parsed elsewhere): no local filtering. */
  searched?: boolean | undefined;
  /** Shown when there is nothing to choose from. */
  empty?: string | undefined;
  /** Single-select only: list the chosen option first (the default). */
  selectedFirst?: boolean | undefined;
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean, gesture: Gesture) => void) | undefined;
  query?: string | undefined;
  onQueryChange?: ((query: string) => void) | undefined;
  footer?: SelectPanelProps['secondaryAction'] | undefined;
  notice?: SelectPanelProps['notice'] | undefined;
  id?: string | undefined;
  width?: SelectPanelProps['width'] | undefined;
  align?: SelectPanelProps['align'] | undefined;
  variant?: 'anchored' | 'modal' | undefined;
} & ({renderAnchor: (props: AnchorProps) => ReactElement; anchorRef?: undefined} | {renderAnchor?: undefined; anchorRef: RefObject<HTMLElement | null>});

/** A SelectPanel over local data: it owns the open and filter state, matching, grouping, virtualization and Enter. */
export const LocalSelectPanel = observer(function LocalSelectPanel(props: LocalSelectPanelProps) {
  const {title, options: source, renderAnchor, multiple = false, searched = false, empty = 'Nothing to choose from on this device.', variant = 'anchored'} = props;
  const [ownOpen, setOwnOpen] = useState(false);
  const [ownQuery, setOwnQuery] = useState('');
  const open = props.open ?? ownOpen;
  const query = props.query ?? ownQuery;
  const changeOpen = (next: boolean, gesture: Gesture) => {
    setOwnOpen(next);
    if (!next) {
      setOwnQuery('');
      props.onQueryChange?.('');
    }
    props.onOpenChange?.(next, gesture);
  };
  const all = !open ? [] : typeof source === 'function' ? source() : source;
  const matched = searched ? all : matchOptions(all, query);
  // A single-select panel lists the chosen option first (Primer's own ordering is behind a feature flag).
  const visible = multiple || !(props.selectedFirst ?? true) ? matched : [...matched].sort((a, b) => Number(b.checked === true) - Number(a.checked === true));
  // Primer cannot virtualize groups, so the rows of a long list name their group inline instead.
  const virtualized = visible.length > VIRTUALIZE_OVER;
  const grouped = !virtualized && visible.some((option) => option.group !== undefined);
  const items = visible.map((option): SelectPanelItemInput => {
    const description = option.description ?? (grouped ? undefined : option.group);
    return {
      id: option.value, text: option.label,
      ...(grouped ? {groupId: option.group ?? ''} : {}),
      ...(description ? {description, descriptionVariant: option.description ? 'block' as const : 'inline' as const} : {}),
      ...(option.leading ? {leadingVisual: () => <>{option.leading}</>} : option.icon ? {leadingVisual: option.icon} : {}),
      ...(option.meta ? {trailingVisual: option.meta} : {}),
      ...(option.disabled ? {disabled: true} : {}),
      // Selection is the option's own state: Primer only shows it.
      onAction: (_, event) => {
        event.preventDefault();
        option.onSelect();
        if (!(option.keepOpen ?? multiple)) changeOpen(false, 'selection');
      },
    };
  });
  const selected = items.filter((_, i) => visible[i]?.checked === true);
  const typed = query.trim();
  const message = {
    variant: 'empty' as const,
    title: typed && !searched && all.length ? 'No matches' : empty,
    body: typed && !searched && all.length ? `Nothing matches “${typed}”.` : '',
  };
  return <SelectPanel title={title} aria-label={title} inputLabel={props.inputLabel ?? title} placeholderText={props.placeholder}
    {...(props.subtitle ? {subtitle: props.subtitle} : {})} {...(props.footer ? {secondaryAction: props.footer} : {})}
    {...(props.notice ? {notice: props.notice} : {})} {...(props.id ? {id: props.id} : {})}
    {...(props.align ? {align: props.align} : {})} width={props.width ?? 'medium'}
    {...(renderAnchor ? {renderAnchor: (anchor: PrimerAnchorProps) => renderAnchor({...anchor, children: undefined})} : {renderAnchor: null, anchorRef: props.anchorRef})}
    {...(variant === 'modal' ? {variant: 'modal' as const, onCancel: () => { changeOpen(false, 'cancel'); }} : {variant: 'anchored' as const})}
    open={open} onOpenChange={changeOpen}
    filterValue={query} onFilterChange={(value) => {
      setOwnQuery(value);
      props.onQueryChange?.(value);
    }}
    items={items} {...(grouped ? {groupMetadata: groupsOf(matched)} : {})}
    {...(multiple ? {selected, onSelectedChange: () => undefined} : {selected: selected[0], onSelectedChange: () => undefined})}
    showSelectedOptionsFirst={false} virtualized={virtualized} loading={false} setInitialFocus focusPrependedElements
    textInputProps={{onKeyDown: enterPicksFirst}}
    {...(items.length ? {} : {message})}/>;
});

function groupsOf(options: readonly PickOption[]) {
  return [...new Set(options.map((option) => option.group ?? ''))].map((group) => group ? {groupId: group, header: {title: group}} : {groupId: group});
}
