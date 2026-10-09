// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Links to the classic UI: what Forgejo Next does not do itself (settings,
// creating repositories, wikis, …) opens Forgejo's own page, in the same tab,
// clearly labelled. The opt-in stays: the classic page's links to pages the
// app renders come back to the app. A canonical route (which the server
// would answer with the app again) asks for the classic page with
// ?ui=classic (routers/livesync/spa.go). The menu row is ClassicMenuItem.tsx:
// menus stay off the boot route (the not-found page renders ClassicLink).

import {AppWindow} from 'lucide-react';
import type {ReactNode} from 'react';
import {Button, type ButtonVariant, Icon} from '../ui/index.ts';
import {CLASSIC_HINT, classicHref} from './classic.ts';
import {useApp} from './store.ts';

export {CLASSIC_HINT, classicHref};

/** A button that opens a classic page. */
export function ClassicLink({to, children, variant = 'ghost', size = 'md'}: {to: string; children: ReactNode; variant?: ButtonVariant; size?: 'sm' | 'md'}) {
  const app = useApp();
  return (
    <Button asChild variant={variant} size={size} tooltip={CLASSIC_HINT}>
      <a href={classicHref(app, to)}><Icon icon={AppWindow} size={size}/>{children}</a>
    </Button>
  );
}
