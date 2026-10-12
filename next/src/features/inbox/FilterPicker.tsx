// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Button} from '@primer/react';
import {TriangleDownIcon} from '@primer/octicons-react';
import {LocalSelectPanel} from '../../components/LocalSelectPanel.tsx';

export function FilterPicker({label, values, value, onChange}: {
  label: string; values: readonly (readonly [string | number, string])[];
  value: string | number | undefined; onChange: (value: string | number | undefined) => void;
}) {
  const current = values.find(([id]) => String(id) === String(value))?.[1];
  return <LocalSelectPanel title={label} placeholder={`Filter by ${label.toLowerCase()}…`}
    options={[[undefined, `All ${label.toLowerCase()}`] as const, ...values].map(([id, text]) => ({
      value: id === undefined ? '' : String(id), label: text, checked: id === undefined ? value === undefined : String(id) === String(value), onSelect: () => { onChange(id); },
    }))}
    renderAnchor={(props) => <Button {...props} size="small" type="button" trailingAction={TriangleDownIcon}>{value === undefined ? label : `${label}: ${current ?? ''}`}</Button>}/>;
}
