// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Banner} from '@primer/react';
import type {ReactNode} from 'react';
import {onlineOnly, useReach} from '../app/online.ts';

/** Above a page of online-only actions while Forgejo cannot be asked; children add what the page still shows. */
export function OfflineBanner({action, children}: {action: string; children?: ReactNode}) {
  const r = useReach();
  if (r === 'online') return null;
  return <Banner variant="warning" title={r === 'offline' ? 'You are offline' : 'Can’t reach Forgejo'} description={<>{onlineOnly(action)}{children && <> {children}</>}</>}/>;
}
