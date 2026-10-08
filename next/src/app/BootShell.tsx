// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The first frame. tools/vite-plugin-shell.ts renders this component to static
// HTML inside #root of index.html at build time; React's first commit (with the
// boot route already loaded, see main.tsx) replaces it. It is built from the
// same layout parts and primitives as the app shell (shell/Frame.tsx), so its
// rows line up with the real ones.
// The splash script (splash.ts) picks the variant via attributes on <html>:
//   data-shell="logged-out"   → the logged-out screen instead of the app frame
//   data-skeleton="detail"    → the issue-detail shape instead of a list
//   [data-sk-row] rows beyond the stored count are hidden

import {Avatar} from '../ui/Avatar.tsx';
import {ListRow} from '../ui/ListRow.tsx';
import {Skeleton} from '../ui/Skeleton.tsx';
import {LoggedOut} from './LoggedOut.tsx';
import {HeaderBar, NavSkeleton, ShellFrame, SidebarBody, SidebarTop} from './shell/Frame.tsx';
import {SKELETON_MAX_ROWS} from './splash.ts';

const navWidths = ['sm', 'md', 'xl'] as const;
const repoWidths = ['lg', 'md', 'xl'] as const;
const rowWidths = ['w-64', 'w-48', 'w-72', 'w-56', 'w-40', 'w-60', 'w-52', 'w-44'];

function Sidebar() {
  return (
    <>
      <SidebarTop>
        <NavSkeleton width="lg" leading={<Avatar size="sm" fromSplash/>}/>
        <NavSkeleton width="sm"/>
      </SidebarTop>
      <SidebarBody>
        {navWidths.map((w, i) => <NavSkeleton key={i} width={w}/>)}
        <div className="h-control"/>
        <NavSkeleton width="md" leading={<Skeleton round="full" className="size-4"/>}/>
        {repoWidths.map((w, i) => <NavSkeleton key={i} width={w} inset/>)}
      </SidebarBody>
    </>
  );
}

function Frame() {
  return (
    <ShellFrame boot sidebar={<Sidebar/>}>
      <HeaderBar>
        <Skeleton className="h-3 w-32"/>
      </HeaderBar>
      <div role="presentation" className="min-h-0 flex-1 overflow-hidden shape-detail:hidden">
        {Array.from({length: SKELETON_MAX_ROWS}, (_, i) => (
          <ListRow
            key={i}
            role="presentation"
            data-sk-row=""
            leading={<><Skeleton className="h-3 w-10"/><Skeleton className="size-4"/></>}
            trailing={<Skeleton className="h-3 w-12"/>}
          >
            <Skeleton className={`h-3 ${rowWidths[i % rowWidths.length] ?? 'w-48'}`}/>
          </ListRow>
        ))}
      </div>
      <div className="hidden min-h-0 flex-1 shape-detail:flex">
        <div className="flex flex-1 flex-col gap-3 px-8 py-6">
          <Skeleton className="h-5 w-96"/>
          <div className="h-2"/>
          <Skeleton className="h-3 w-full"/>
          <Skeleton className="h-3 w-full"/>
          <Skeleton className="h-3 w-2/3"/>
        </div>
        <div className="flex w-pane shrink-0 flex-col gap-3 border-l border-border p-4">
          <Skeleton className="h-3 w-20"/>
          <Skeleton className="h-3 w-32"/>
          <Skeleton className="h-3 w-24"/>
        </div>
      </div>
    </ShellFrame>
  );
}

export function BootShell() {
  return (
    <>
      <Frame/>
      <LoggedOut boot="logged-out"/>
    </>
  );
}
