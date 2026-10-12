// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {useState} from 'react';
import {Button, SelectPanel} from '@primer/react';
import {TriangleDownIcon} from '@primer/octicons-react';

export function FilterPicker({label, values, value, onChange}: {
  label: string; values: readonly (readonly [string | number, string])[];
  value: string | number | undefined; onChange: (value: string | number | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const all = {id: 'all', text: `All ${label.toLowerCase()}`};
  const items = [all, ...values.map(([id, text]) => ({id: String(id), text}))];
  const selected = items.find((item) => item.id === (value === undefined ? 'all' : String(value)));
  return <SelectPanel title={label} open={open} onOpenChange={setOpen} selected={selected}
    filterValue={filter} onFilterChange={setFilter} placeholderText={`Filter by ${label.toLowerCase()}…`}
    items={items.filter((item) => item.text.toLowerCase().includes(filter.toLowerCase()))} virtualized={values.length > 50}
    onSelectedChange={(item: {id?: string | number | undefined} | undefined) => {
      onChange(item?.id === 'all' ? undefined : values.find(([id]) => String(id) === item?.id)?.[0]);
      setOpen(false);
    }}
    renderAnchor={(props) => <Button {...{...props}} size="small" type="button" trailingAction={TriangleDownIcon}>{value === undefined ? label : `${label}: ${selected?.text ?? ''}`}</Button>}/>;
}
