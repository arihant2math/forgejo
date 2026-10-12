// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A menu row that opens a classic page (see ClassicLink.tsx). Its own module:
// the menu primitives are not on the boot route.
import {classicHref} from './classic.ts';
import {useApp} from './store.ts';
import {BrowserIcon} from '@primer/octicons-react';
import {ActionList} from '@primer/react';
import {createElement} from 'react';

/** A menu row that opens a classic page (the account menu, a repository's "More"). */
export function ClassicMenuItem({to, children, icon = BrowserIcon}: {to: string; children: string; icon?: typeof BrowserIcon}) {
  const app = useApp();
  return <ActionList.LinkItem href={classicHref(app, to)} data-classic=""><ActionList.LeadingVisual>{createElement(icon)}</ActionList.LeadingVisual>{children}<ActionList.TrailingVisual>classic</ActionList.TrailingVisual></ActionList.LinkItem>;
}
