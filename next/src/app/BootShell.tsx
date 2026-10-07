// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The first frame. tools/vite-plugin-shell.ts renders this component to static
// HTML inside #root of index.html at build time, and the app renders it again
// as the Suspense fallback while the route chunk loads, so React's first
// commit replaces it with identical markup. The splash script (splash.ts)
// picks the variant via attributes on <html>:
//   data-shell="logged-out"   → the logged-out panel instead of the app frame
//   data-skeleton="detail"    → the issue-detail shape instead of a list
//   [data-sk-row] rows beyond the stored count are hidden

import {LogIn} from 'lucide-react';
import {EmptyState} from '../ui/EmptyState.tsx';
import {Skeleton} from '../ui/Skeleton.tsx';
import {SKELETON_MAX_ROWS} from './splash.ts';

const navWidths = ['w-24', 'w-20', 'w-28', 'w-16', 'w-24', 'w-20'];
const rowWidths = ['w-64', 'w-48', 'w-72', 'w-56', 'w-40', 'w-60', 'w-52', 'w-44'];

function Frame() {
  return (
    <div className="flex h-full logged-out:hidden">
      <aside className="flex w-sidebar shrink-0 flex-col gap-0.5 border-r border-border bg-canvas p-2">
        <div className="flex h-control items-center gap-2 px-2">
          <span className="flex size-5 items-center justify-center rounded-full bg-skeleton text-xs font-medium text-fg-muted splash-initial"/>
          <Skeleton className="h-3 w-24"/>
        </div>
        <div className="h-2"/>
        {navWidths.map((w, i) => (
          <div key={i} className="flex h-control items-center gap-2 px-2">
            <Skeleton className="size-4"/>
            <Skeleton className={`h-3 ${w}`}/>
          </div>
        ))}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-surface">
        <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
          <Skeleton className="h-3 w-32"/>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden shape-detail:hidden">
          {Array.from({length: SKELETON_MAX_ROWS}, (_, i) => (
            <div key={i} data-sk-row="" className="flex h-row items-center gap-3 border-b border-border-subtle px-3">
              <Skeleton className="size-4"/>
              <Skeleton className="h-3 w-10"/>
              <Skeleton className={`h-3 ${rowWidths[i % rowWidths.length] ?? 'w-48'}`}/>
              <Skeleton className="ml-auto h-3 w-12"/>
            </div>
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
          <div className="flex w-sidebar shrink-0 flex-col gap-3 border-l border-border p-4">
            <Skeleton className="h-3 w-20"/>
            <Skeleton className="h-3 w-32"/>
            <Skeleton className="h-3 w-24"/>
          </div>
        </div>
      </main>
    </div>
  );
}

function LoggedOut() {
  return (
    <div className="hidden h-full items-center justify-center bg-canvas logged-out:flex">
      <EmptyState icon={LogIn} title="Forgejo" description="Sign in to continue." action={<Skeleton round="md" className="h-control w-20"/>}/>
    </div>
  );
}

export function BootShell() {
  return (
    <>
      <Frame/>
      <LoggedOut/>
    </>
  );
}
