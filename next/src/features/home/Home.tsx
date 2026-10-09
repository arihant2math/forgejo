// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The dashboard (/): where the app starts. The boot route renders the header
// at once; what is waiting for the viewer (Dashboard.tsx) is its own chunk,
// so the boot route stays small.

import {Home as HomeIcon} from 'lucide-react';
import {lazyComponent} from '../../app/lazy.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {PageBody} from '../../app/shell/Frame.tsx';

const Dashboard = lazyComponent(() => import('./Dashboard.tsx').then((m) => m.default));

export default function Home() {
  return (
    <>
      <PageHeader icon={HomeIcon} title="Home"/>
      <PageBody><Dashboard/></PageBody>
    </>
  );
}
