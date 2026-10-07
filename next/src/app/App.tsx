// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Suspense} from 'react';
import {TooltipProvider} from '../ui/Tooltip.tsx';
import {BootShell} from './BootShell.tsx';
import {RouteView} from './routes.tsx';

export function App({pathname}: {pathname: string}) {
  return (
    <TooltipProvider>
      <Suspense fallback={<BootShell/>}>
        <RouteView pathname={pathname}/>
      </Suspense>
    </TooltipProvider>
  );
}
