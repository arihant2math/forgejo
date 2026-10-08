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
import {TooltipProvider} from '../../ui/index.ts';
import {lazyComponent, whenIdle} from '../lazy.tsx';
import {LoggedOut} from '../LoggedOut.tsx';
import {signInHere} from '../session.ts';
import {shortcuts, useShortcut} from '../shortcuts/index.ts';
import {type App, useApp} from '../store.ts';
import {ShellFrame} from './Frame.tsx';
import {Sidebar} from './Sidebar.tsx';

const Palette = lazyComponent(() => import('../palette/Palette.tsx').then((m) => m.Palette));
const ShortcutsDialog = lazyComponent(() => import('./Overlays.tsx').then((m) => m.ShortcutsDialog));
const SignOutDialog = lazyComponent(() => import('./Overlays.tsx').then((m) => m.SignOutDialog));

/** Stays mounted once opened, so that closing can fade out. */
const PaletteHost = observer(function PaletteHost({app}: {app: App}) {
  const open = app.ui.paletteOpen;
  const [used, setUsed] = useState(false);
  if (open && !used) setUsed(true);
  return open || used ? <Palette open={open}/> : null;
});

const Overlays = observer(function Overlays({app}: {app: App}) {
  return (
    <>
      <PaletteHost app={app}/>
      {app.ui.shortcutsOpen && <ShortcutsDialog/>}
      {app.ui.signOut && <SignOutDialog pending={app.ui.signOut.pending}/>}
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
  return null;
}

function AppShell({app}: {app: App}) {
  useEffect(() => {
    // The first frame rendered from local data (PLAN §5.2 step 3).
    markOnce('firstPaintFromCache');
    whenIdle(() => {
      void Palette.preload().catch(() => undefined);
    });
  }, []);
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
