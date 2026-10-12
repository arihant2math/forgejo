// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {Outlet, useNavigate, useRouterState} from '@tanstack/react-router';
import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {useEffect, useRef, useState} from 'react';
import {markOnce} from '../../sync/rum.ts';
import {classicHref} from '../classic.ts';
import {sitePath, uiPath} from '../config.ts';
import {classicOfLocation, publicPageRepo} from '../paths.ts';
import {claimClassicHandoff} from '../gate.ts';

import {lazyComponent, whenIdle} from '../lazy.tsx';
import {openCreate} from '../create.ts';
import {goToCode} from '../goto.ts';
import {lastBoard} from '../lastBoard.ts';
import {undoLatest} from '../notices.ts';
import {LoggedOut} from '../LoggedOut.tsx';
import {pendingWebLogout} from '../../auth/weblogout.ts';
import {signInHere} from '../session.ts';
import {shortcuts, useShortcut} from '../shortcuts/index.ts';
import {type App, useApp} from '../store.ts';
import {ShellFrame} from './Frame.tsx';
import {NoticeViewport} from './NoticeViewport.tsx';
import {Sidebar} from './Sidebar.tsx';
import {closeDrawer, drawerOpen, toggleSidebar} from './sidebar.ts';

/** Decide the hand-off once per app. */
const classicHandoff = new WeakMap<App, boolean>();
function handoffFromClassicSignIn(app: App): boolean {
  let handoff = classicHandoff.get(app);
  if (handoff === undefined) {
    handoff = !app.session && !pendingWebLogout() && claimClassicHandoff(app.config, document.referrer, location.origin);
    classicHandoff.set(app, handoff);
  }
  return handoff;
}

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

/** Remains mounted after first use for close animations. */
const PickerHost = observer(function PickerHost({app}: {app: App}) {
  const open = Boolean(app.ui.picker);
  const [used, setUsed] = useState(false);
  if (open && !used) setUsed(true);
  return open || used ? <IssuePicker/> : null;
});

/** Remains mounted after first use for close animations. */
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
  useEffect(() => {
    shortcuts.overlayOpen = () => app.ui.paletteOpen || Boolean(app.ui.create) || Boolean(app.ui.picker) || app.ui.shortcutsOpen || app.ui.unsyncedOpen;
    return () => {
      shortcuts.overlayOpen = () => false;
    };
  }, [app]);
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
  useShortcut('go.home', () => void navigate({to: '/'}));
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
  useShortcut('sidebar.toggle', toggleSidebar);
  useShortcut('undo', () => {
    undoLatest(app);
  });
  // Close the drawer before navigation or overlays so dialogs cannot appear underneath it.
  const path = useRouterState({select: (st) => st.location.pathname});
  const last = useRef(path);
  useEffect(() => {
    closeDrawer();
    if (last.current !== path) {
      const from = last.current;
      runInAction(() => {
        app.ui.previousPath = from;
      });
      last.current = path;
    }
  }, [app, path]);
  useEffect(() => reaction(() => app.ui.paletteOpen || Boolean(app.ui.create) || app.ui.shortcutsOpen || app.ui.unsyncedOpen || Boolean(app.ui.picker), (open) => {
    if (open) closeDrawer();
  }), [app]);
  useEffect(() => {
    // Capture Esc before shortcuts so closing the drawer cannot also navigate back.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !drawerOpen()) return;
      e.stopPropagation();
      e.preventDefault();
      closeDrawer(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);
  useShortcut('go.code', () => {
    goToCode(app, navigate);
  });
  return null;
}

function AppShell({app}: {app: App}) {
  // Revoke cached git content even if this tab never opened a code view.
  useEffect(() => app.session?.data.on('revoked', ({group}) => {
    if (!group.startsWith('repo:') || !app.session) return;
    const db = app.session.data.db;
    void import('../../code/cache.ts').then((m) => new m.CodeCache(db).purgeRepo(Number(group.slice(5)))).catch(() => undefined);
  }), [app]);
  useEffect(() => {
    // Count cached first paint only when a workspace already exists.
    if (app.session?.data.workspace.current) markOnce('firstPaintFromCache');
    whenIdle(() => {
      // Preload keyboard overlays so they open immediately and remain available offline.
      for (const overlay of [Palette, CreateIssue, IssuePicker, Notices, UnsyncedPanel, ShortcutsDialog]) void overlay.preload().catch(() => undefined);
      // Precache only after first paint to keep boot fast.
      void import('../sw.ts').then((m) => {
        m.startServiceWorker(app);
      }).catch(() => undefined);
      void import('../../code/prefetch.ts').then((m) => {
        m.startPrefetch(app);
      }).catch(() => undefined);
      void import('../rum.ts').then((m) => {
        m.startRum(sitePath(app.config, '/-/sync/rum'));
      }).catch(() => undefined);
    });
  }, [app]);
  return (
    <>
      <GlobalShortcuts app={app}/>
      <ShellFrame sidebar={<Sidebar/>} onBackdrop={() => { closeDrawer(true); }}>
        <Outlet/>
      </ShellFrame>
      <Overlays app={app}/>
    </>
  );
}

export function Shell() {
  const app = useApp();
  const {pathname, searchStr} = useRouterState({select: (st) => ({pathname: st.location.pathname, searchStr: st.location.searchStr}), structuralSharing: true});
  const classicPage = classicOfLocation(pathname, searchStr);
  const [publicPage, setPublicPage] = useState<string>();
  useEffect(() => {
    if (app.session) return;
    // Verify anonymously: a repository visible to the previous account may be private.
    const match = publicPageRepo(classicPage);
    if (!match || searchStr) return;
    const controller = new AbortController();
    void fetch(sitePath(app.config, `/api/v1/repos/${encodeURIComponent(match.owner)}/${encodeURIComponent(match.repo)}`), {
      credentials: 'omit', signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const repo: unknown = await response.json();
      if (repo && typeof repo === 'object' && 'private' in repo && repo.private === false) setPublicPage(classicPage);
    }).catch(() => undefined);
    return () => { controller.abort(); };
  }, [app, app.session, classicPage, searchStr]);
  // Forgejo's web session is separate from app OAuth; continue authorization without another sign-in prompt.
  const handoff = handoffFromClassicSignIn(app);
  useEffect(() => {
    if (handoff && !app.session) signInHere(app);
  }, [app, handoff]);
  if (!app.session) {
    const classic = classicOfLocation(pathname, searchStr);
    const webSession = pendingWebLogout() ? 'You are signed out here. Forgejo\'s own session on this device ends as soon as it is back online.' : undefined;
    const message = webSession ?? (handoff ? 'You are signed in to Forgejo. Connecting Forgejo Next to your account…' : undefined);
    return <LoggedOut appName={app.config.app_name} message={message} onSignIn={app.config.oauth ? () => {
      signInHere(app);
    } : undefined} classic={{
      page: publicPage === classicPage ? classicHref(app, classic) : undefined,
      optOut: `${uiPath(app.config, 'opt-out')}?redirect=${encodeURIComponent(sitePath(app.config, classic))}`,
    }}/>;
  }
  return <AppShell app={app}/>;
}
