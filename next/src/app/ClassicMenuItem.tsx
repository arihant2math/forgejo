// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Kept separate so menu primitives stay off the boot route.
import {classicHref} from './classic.ts';
import {useApp} from './store.ts';
import {BrowserIcon} from '@primer/octicons-react';
import {ActionList} from '@primer/react';
import {createElement} from 'react';

export function ClassicMenuItem({to, children, icon = BrowserIcon}: {to: string; children: string; icon?: typeof BrowserIcon}) {
  const app = useApp();
  return <ActionList.LinkItem href={classicHref(app, to)} data-classic=""><ActionList.LeadingVisual>{createElement(icon)}</ActionList.LeadingVisual>{children}<ActionList.TrailingVisual>classic</ActionList.TrailingVisual></ActionList.LinkItem>;
}
