// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The layout route of every canonical page: the logged-out screen when
// nobody is signed in on this device, otherwise the app shell (sidebar,
// the page, and the overlays: ⌘K palette, shortcuts help, sign-out warning).

import {Outlet, useNavigate} from '@tanstack/react-router';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {markOnce} from '../../sync/rum.ts';
import {NoticeViewport, TooltipProvider} from '../../ui/index.ts';
import {lazyComponent, whenIdle} from '../lazy.tsx';
import {openCreate} from '../create.ts';
import {lastBoard} from '../lastBoard.ts';
import {LoggedOut} from '../LoggedOut.tsx';
import {signInHere} from '../session.ts';
import {shortcuts, useShortcut} from '../shortcuts/index.ts';
import {type App, useApp} from '../store.ts';
import {ShellFrame} from './Frame.tsx';
import {Sidebar} from './Sidebar.tsx';

const Palette = lazyComponent(() => import('../palette/Palette.tsx').then((m) => m.Palette));
const ShortcutsDialog = lazyComponent(() => import('./Overlays.tsx').then((m) => m.ShortcutsDialog));
const SignOutDialog = lazyComponent(() => import('./Overlays.tsx').then((m) => m.SignOutDialog));
const UnsyncedPanel = lazyComponent(() => import('./Unsynced.tsx').then((m) => m.UnsyncedPanel));
const Notices = lazyComponent(() => import('./Notices.tsx').then((m) => m.Notices));
const CreateIssue = lazyComponent(() => import('../../features/create/CreateIssue.tsx').then((m) => m.CreateIssue));
const IssuePicker = lazyComponent(() => import('../../features/issues/Picker.tsx').then((m) => m.IssuePicker));

/** Stays mounted once opened, so that closing can fade out. */
const PaletteHost = observer(function PaletteHost({app}: {app: App}) {
  const open = app.ui.paletteOpen;
  const [used, setUsed] = useState(false);
  if (open && !used) setUsed(true);
  return open || used ? <Palette open={open}/> : null;
});

/** The issue pickers (S/L/A/M/P), mounted from their first use on (they fade out). */
const PickerHost = observer(function PickerHost({app}: {app: App}) {
  const open = Boolean(app.ui.picker);
  const [used, setUsed] = useState(false);
  if (open && !used) setUsed(true);
  return open || used ? <IssuePicker/> : null;
});

/** The new-issue dialog (C), mounted from its first use on (it fades out). */
const CreateHost = observer(function CreateHost({app}: {app: App}) {
  const open = Boolean(app.ui.create);
  const [used, setUsed] = useState(false);
  if (open && !used) setUsed(true);
  return open || used ? <CreateIssue/> : null;
});

const Overlays = observer(function Overlays({app}: {app: App}) {
  return (
    <>
      <PaletteHost app={app}/>
      <PickerHost app={app}/>
      <CreateHost app={app}/>
      {app.ui.shortcutsOpen && <ShortcutsDialog/>}
      {app.ui.signOut && <SignOutDialog pending={app.ui.signOut.pending}/>}
      {app.ui.unsyncedOpen && <UnsyncedPanel/>}
      <NoticeViewport>{app.ui.notices.length > 0 && <Notices/>}</NoticeViewport>
    </>
  );
});

function GlobalShortcuts({app}: {app: App}) {
  const navigate = useNavigate();
  useEffect(() => shortcuts.attach(window), []);
  useShortcut('palette.open', () => {
    runInAction(() => {
      app.ui.paletteOpen = !app.ui.paletteOpen;
    });
  });
  useShortcut('help.shortcuts', () => {
    runInAction(() => {
      app.ui.shortcutsOpen = true;
    });
  });
  useShortcut('go.inbox', () => void navigate({to: '/notifications'}));
  useShortcut('go.issues', () => void navigate({to: '/issues'}));
  useShortcut('go.pulls', () => void navigate({to: '/pulls'}));
  useShortcut('create', () => {
    openCreate(app);
  });
  useShortcut('go.board', () => {
    const id = app.session && lastBoard(app.session.userId);
    void navigate(id ? {to: '/-/next/projects/$id', params: {id: String(id)}} : {to: '/-/next/boards'});
  });
  useShortcut('go.code', () => {
    const r = app.session?.data.pool.model('Repository').get(app.ui.repoOpen)?.data;
    if (r) void navigate({to: '/-/next/code/$owner/$repo/$', params: {owner: r.owner_name, repo: r.name, _splat: 'src/-'}});
  });
  return null;
}

function AppShell({app}: {app: App}) {
  // A repository the viewer may no longer read: its git content leaves this device's code cache (F7),
  // whether or not a code view ever opened in this tab.
  useEffect(() => app.session?.data.on('revoked', ({group}) => {
    if (!group.startsWith('repo:') || !app.session) return;
    const db = app.session.data.db;
    void import('../../code/cache.ts').then((m) => new m.CodeCache(db).purgeRepo(Number(group.slice(5)))).catch(() => undefined);
  }), [app]);
  useEffect(() => {
    // The first frame rendered from local data (PLAN §5.2 step 3).
    markOnce('firstPaintFromCache');
    whenIdle(() => {
      void Palette.preload().catch(() => undefined);
      // After the first paint: the service worker precaches this build (offline boots, PLAN §5.2 step 5).
      void import('../sw.ts').then((m) => {
        m.startServiceWorker(app);
      }).catch(() => undefined);
      // Pull requests awaiting the viewer's review: their diffs and files onto this device (PLAN §5.5, F7).
      void import('../../code/prefetch.ts').then((m) => {
        m.startPrefetch(app);
      }).catch(() => undefined);
    });
  }, [app]);
  return (
    <TooltipProvider>
      <GlobalShortcuts app={app}/>
      <ShellFrame sidebar={<Sidebar/>}>
        <Outlet/>
      </ShellFrame>
      <Overlays app={app}/>
    </TooltipProvider>
  );
}

export function Shell() {
  const app = useApp();
  if (!app.session) return <LoggedOut onSignIn={app.config.oauth ? () => {
    signInHere(app);
  } : undefined}/>;
  return <AppShell app={app}/>;
}
