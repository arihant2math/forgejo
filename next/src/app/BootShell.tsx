// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Rendered into index.html at build time; shared layout parts keep the first frame aligned with the app.
// The splash script selects the shell, skeleton and header via <html> attributes and hides excess skeleton rows.

import {LoggedOut} from './LoggedOut.tsx';
import {HeaderRow, HeaderStack, NavSkeleton, ShellFrame, SidebarBody, SidebarTop} from './shell/Frame.tsx';
import {SKELETON_MAX_ROWS} from './splash.ts';
import {SkeletonAvatar, SkeletonBox, SkeletonText} from '@primer/react/experimental';

const navWidths = ['sm', 'md', 'xl', 'sm'] as const;
const repoWidths = ['lg', 'md', 'xl'] as const;
const rowWidths = ['w-64', 'w-48', 'w-72', 'w-56', 'w-40', 'w-60', 'w-52', 'w-44'];
const tabWidths = ['w-10', 'w-12', 'w-24', 'w-14', 'w-16', 'w-10'];

function Sidebar() {
  return (
    <>
      <SidebarTop>
        <NavSkeleton width="lg" leading={<SkeletonAvatar size={20}/>}/>
        <NavSkeleton width="sm"/>
      </SidebarTop>
      <SidebarBody>
        {navWidths.map((w, i) => <NavSkeleton key={i} width={w}/>)}
        <div className="h-control"/>
        <NavSkeleton width="md" leading={<SkeletonAvatar size={20}/>}/>
        {repoWidths.map((w, i) => <NavSkeleton key={i} width={w} inset/>)}
      </SidebarBody>
    </>
  );
}

function Frame() {
  return (
    <ShellFrame boot sidebar={<Sidebar/>}>
      <HeaderStack>
        <HeaderRow>
          <SkeletonBox className="h-3 w-32"/>
        </HeaderRow>
        <div className="hidden header-tabs:contents">
          <div className="flex h-header shrink-0 items-center gap-6 border-b border-default px-6">
            {tabWidths.map((w, i) => <SkeletonBox key={i} className={`h-3 ${w}`}/>)}
          </div>
        </div>
        <div className="hidden header-toolbar:contents">
          <HeaderRow>
            <span className="flex min-w-0 max-md:flex-1 max-md:basis-0 max-md:py-2"><SkeletonBox className="my-1 h-3 w-24"/></span>
            <span className="hidden max-md:order-last max-md:block max-md:w-full"/>
            <span className="flex p-1 max-md:order-last"><SkeletonBox className="h-control-sm w-40"/></span>
          </HeaderRow>
        </div>
      </HeaderStack>
      <div role="presentation" className="min-h-0 flex-1 overflow-hidden shape-detail:hidden">
        {Array.from({length: SKELETON_MAX_ROWS}, (_, i) => (
          <div key={i} role="presentation" data-sk-row="" className="flex h-row items-center gap-2 border-b border-muted px-4">
            <SkeletonBox className="h-3 w-10"/><SkeletonBox className="size-4"/>
            <SkeletonBox className={`h-3 ${rowWidths[i % rowWidths.length] ?? 'w-48'}`}/>
            <SkeletonBox className="ml-auto h-3 w-12"/>
          </div>
        ))}
      </div>
      <div className="hidden min-h-0 flex-1 shape-detail:flex">
        <div className="flex flex-1 flex-col gap-4 px-8 py-6">
          <SkeletonBox className="h-5 w-96"/>
          <div className="h-2"/>
          <SkeletonText lines={3}/>
        </div>
        <div className="flex w-pane shrink-0 flex-col gap-4 border-l border-default p-4">
          <SkeletonBox className="h-3 w-20"/>
          <SkeletonBox className="h-3 w-32"/>
          <SkeletonBox className="h-3 w-24"/>
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
