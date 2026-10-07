// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The first frame. tools/vite-plugin-shell.ts renders this component to static
// HTML inside #root of index.html at build time; React's first commit (with the
// boot route already loaded, see routes.ts) replaces it. It is composed from
// the same primitives as the app, so its rows line up with the real ones.
// The splash script (splash.ts) picks the variant via attributes on <html>:
//   data-shell="logged-out"   → the logged-out screen instead of the app frame
//   data-skeleton="detail"    → the issue-detail shape instead of a list
//   [data-sk-row] rows beyond the stored count are hidden

import {Avatar} from '../ui/Avatar.tsx';
import {ListRow} from '../ui/ListRow.tsx';
import {Skeleton} from '../ui/Skeleton.tsx';
import {LoggedOut} from './LoggedOut.tsx';
import {SKELETON_MAX_ROWS} from './splash.ts';

const navWidths = ['w-24', 'w-20', 'w-28', 'w-16', 'w-24', 'w-20'];
const rowWidths = ['w-64', 'w-48', 'w-72', 'w-56', 'w-40', 'w-60', 'w-52', 'w-44'];
// Sidebar rows until F3 adds the navigation primitive.
const navRow = 'flex h-control items-center gap-2 px-2';

function Frame() {
  return (
    <div className="flex h-full logged-out:hidden">
      <aside className="flex w-sidebar shrink-0 flex-col gap-0.5 border-r border-border bg-canvas p-2">
        <div className={navRow}>
          <Avatar fromSplash/>
          <Skeleton className="h-3 w-24"/>
        </div>
        <div className="h-2"/>
        {navWidths.map((w, i) => (
          <div key={i} className={navRow}>
            <Skeleton className="size-4"/>
            <Skeleton className={`h-3 ${w}`}/>
          </div>
        ))}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-surface">
        <header className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
          <Skeleton className="h-3 w-32"/>
        </header>
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
      </main>
    </div>
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
