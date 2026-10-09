// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The dashboard (/): where the app starts. The boot route renders the header
// and Home's placeholders at once; what is waiting for the viewer
// (Dashboard.tsx) is its own chunk (the server preloads it with the document:
// spa_preload.go), so the boot route stays small and the first frame is
// never an empty page.

import {Home as HomeIcon} from 'lucide-react';
import {lazyComponent} from '../../app/lazy.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {ListRow, Panel, Skeleton} from '../../ui/index.ts';

/**
 * Home while the device loads what is waiting (its chunk, a first sign-in's sync): the sections' shape, static
 * placeholders, no spinner — the same before and after the chunk arrives, until the real layout replaces it once.
 */
export function HomeSkeleton() {
  return (
    <PageColumn>
      <div aria-busy aria-label="Loading" className="flex flex-col gap-4">
        {['w-24', 'w-32', 'w-28'].map((w) => (
          <Panel key={w} label="Loading" title={<Skeleton className={`h-3 ${w}`}/>}>
            {['w-72', 'w-56', 'w-64'].map((r) => (
              <ListRow key={r} role="presentation" leading={<Skeleton className="size-4"/>} trailing={<Skeleton className="h-3 w-12"/>}>
                <Skeleton className={`h-3 ${r}`}/>
              </ListRow>
            ))}
          </Panel>
        ))}
      </div>
    </PageColumn>
  );
}

const Dashboard = lazyComponent(() => import('./Dashboard.tsx').then((m) => m.default), <HomeSkeleton/>);

export default function Home() {
  return (
    <>
      <PageHeader icon={HomeIcon} title="Home"/>
      <PageBody><Dashboard/></PageBody>
    </>
  );
}
