// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import type {ComponentProps, ReactNode} from 'react';
import {LinkButton, Tooltip} from '@primer/react';
import {BrowserIcon} from '@primer/octicons-react';
import {CLASSIC_HINT, classicHref} from './classic.ts';
import {useApp} from './store.ts';

export {CLASSIC_HINT, classicHref};

/** A same-tab classic link; data-classic keeps the app's link crawler from following it. */
export function ClassicLink({to, children, variant = 'invisible', size = 'medium'}: {
  to: string;
  children: ReactNode;
  variant?: ComponentProps<typeof LinkButton>['variant'];
  size?: ComponentProps<typeof LinkButton>['size'];
}) {
  const app = useApp();
  return (
    <Tooltip text={CLASSIC_HINT}>
      <LinkButton href={classicHref(app, to)} data-classic="" variant={variant} size={size} leadingVisual={BrowserIcon}>
        {children}<span> · classic</span>
      </LinkButton>
    </Tooltip>
  );
}
