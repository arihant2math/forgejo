// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
import {useState, type ReactElement} from 'react';
import {SelectPanel, type SelectPanelProps, type SelectPanelItemInput as ItemInput} from '@primer/react';

/** Local-data pickers: no network work while typing; virtualize large collections. */
type LocalSelectProps = Omit<SelectPanelProps, 'open' | 'onOpenChange' | 'filterValue' | 'onFilterChange' | 'className' | 'selected' | 'onSelectedChange' | 'renderAnchor' | 'variant' | 'onCancel' | 'anchorRef'> & {
  renderAnchor: NonNullable<SelectPanelProps['renderAnchor']>;
};
type SingleSelectProps = LocalSelectProps & {selected: ItemInput | undefined; onSelectedChange: (item: ItemInput | undefined) => void};
type MultiSelectProps = LocalSelectProps & {selected: ItemInput[]; onSelectedChange: (items: ItemInput[]) => void};

export function FilteredSelect(props: MultiSelectProps): ReactElement;
// eslint-disable-next-line typescript/unified-signatures -- Separate overloads preserve contextual callback types for single and multiple selection.
export function FilteredSelect(props: SingleSelectProps): ReactElement;
export function FilteredSelect({message, ...props}: SingleSelectProps | MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const query = filter.toLocaleLowerCase();
  const items = props.items.filter((item) => `${item.text ?? ''} ${typeof item.description === 'string' ? item.description : ''}`.toLocaleLowerCase().includes(query));
  // Single-select Enter must keep the current value, including the first opening.
  if (props.selected && !Array.isArray(props.selected)) {
    const selectedId = props.selected.id;
    items.sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId));
  }
  // eslint-disable-next-line tokens/no-restyle -- Forward native Primer picker props; styling is excluded from the local API.
  return <SelectPanel {...props} items={items} open={open} onOpenChange={setOpen}
    filterValue={filter} onFilterChange={setFilter} loading={false} virtualized={items.length > 50}
    {...(items.length === 0 && message ? {message} : {})}/>;
}
