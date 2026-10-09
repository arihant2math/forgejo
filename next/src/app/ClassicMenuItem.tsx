// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A menu row that opens a classic page (see ClassicLink.tsx). Its own module:
// the menu primitives are not on the boot route.

import {AppWindow} from 'lucide-react';
import {MenuItem} from '../ui/index.ts';
import {classicHref} from './classic.ts';
import {useApp} from './store.ts';

/** A menu row that opens a classic page (the account menu, a repository's "More"). */
export function ClassicMenuItem({to, children, icon = AppWindow}: {to: string; children: string; icon?: typeof AppWindow}) {
  const app = useApp();
  return <MenuItem icon={icon} href={classicHref(app, to)} hint="classic">{children}</MenuItem>;
}
