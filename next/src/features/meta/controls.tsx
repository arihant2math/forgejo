// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ArrowSwitchIcon} from '@primer/octicons-react';
import {Button, ActionMenu, ActionList} from '@primer/react';

export function SortMenu<S extends string>({value, names, onChange}: {value: S; names: Record<S, string>; onChange: (sort: S) => void}) {
  return (
    <ActionMenu>
      <ActionMenu.Anchor><Button variant="invisible" size="small" leadingVisual={ArrowSwitchIcon} type="button" aria-label={`Sort: ${names[value]}`}>Sort</Button></ActionMenu.Anchor>
      <ActionMenu.Overlay><ActionList>
        <ActionList.Group selectionVariant="single"><ActionList.GroupHeading>Sort</ActionList.GroupHeading>
        
          {(Object.keys(names) as S[]).map((s) => <ActionList.Item key={s} selected={value === s} onSelect={() => { onChange(s); }}>{names[s]}</ActionList.Item>)}
        </ActionList.Group>
      </ActionList></ActionMenu.Overlay>
    </ActionMenu>
  );
}
