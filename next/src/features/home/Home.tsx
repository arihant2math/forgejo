// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Lazy content keeps the boot route small; immediate placeholders avoid an empty first frame.
import {lazyComponent} from '../../app/lazy.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {BorderBox} from '../../components/BorderBox.tsx';
import {ListRow} from '../../components/ListRow.tsx';
import {HomeIcon} from '@primer/octicons-react';
import {SkeletonBox} from '@primer/react/experimental';

export function HomeSkeleton() {
  return (
    <PageColumn>
      <div aria-busy aria-label="Loading" className="flex flex-col gap-4">
        {['w-24', 'w-32', 'w-28'].map((w) => (
          <BorderBox key={w} label="Loading" title={<SkeletonBox className={`h-3 ${w}`}/>}>
            {['w-72', 'w-56', 'w-64'].map((r) => (
              <ListRow key={r} role="presentation" leading={<SkeletonBox className="size-4"/>} trailing={<SkeletonBox className="h-3 w-12"/>}>
                <SkeletonBox className={`h-3 ${r}`}/>
              </ListRow>
            ))}
          </BorderBox>
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
