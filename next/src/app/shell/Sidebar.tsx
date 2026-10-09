// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The sidebar: account, search, the viewer's views and the workspace's
// owners and repositories. Each part that reads the pool is its own observer
// leaf, so a delta re-renders the row it changed and nothing else.

import {Link, useRouterState} from '@tanstack/react-router';
import {CircleDot, GitPullRequest, Home, Inbox, KanbanSquare, PanelLeftClose, Search, SquarePen} from 'lucide-react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {memo, useCallback, useEffect, useState} from 'react';
import {groupId, groupKind} from '../../data/models.ts';
import {Avatar, IconButton, NavGroup, NavHeading, NavItem, ResizeHandle} from '../../ui/index.ts';
import {repoOfPath} from '../paths.ts';
import {shortcutHint} from '../shortcuts/index.ts';
import {LOCAL_PREFS, readSplash, SIDEBAR_MAX, SIDEBAR_MIN, writeSplash} from '../splash.ts';
import {type Session, useApp, useSession} from '../store.ts';
import {openCreate} from '../create.ts';
import {lazyComponent, whenIdle} from '../lazy.tsx';
import {AccountMenu} from './AccountMenu.tsx';
import {SidebarBody, SidebarTop} from './Frame.tsx';
import {toggleSidebar} from './sidebar.ts';

/** New issue (C): Linear's compose button, at the top. */
function SidebarCreate() {
  const app = useApp();
  return <NavItem icon={SquarePen} label="New issue" shortcut={shortcutHint('create')} onClick={() => {
    openCreate(app);
  }}/>;
}

const SidebarSearch = function SidebarSearch() {
  const {ui} = useApp();
  return (
    <NavItem icon={Search} label="Search" shortcut={shortcutHint('palette.open')} onClick={() => {
      runInAction(() => {
        ui.paletteOpen = true;
      });
    }}/>
  );
};

const InboxItem = observer(function InboxItem() {
  const {data} = useSession();
  const {ui} = useApp();
  // The overlay-aware count once the queue runs (a read marked offline counts at once), else the pool's.
  const unread = ui.unread ?? data.pool.model('Notification').by('status', 'unread').size;
  return <NavItem asChild icon={Inbox} label="Inbox" count={unread} shortcut={shortcutHint('go.inbox')}><Link to="/notifications"/></NavItem>;
});

// ── Workspace: owners and their repositories ─────────────────────────────

const PREFS = LOCAL_PREFS[0];
/** Repositories listed per owner before "N more". */
const SHOWN = 10;

function readClosed(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PREFS) ?? '{}');
    const closed = v && typeof v === 'object' ? (v as {closed?: unknown}).closed : undefined;
    return new Set(Array.isArray(closed) ? closed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeClosed(closed: Set<string>): void {
  try {
    localStorage.setItem(PREFS, JSON.stringify({closed: [...closed]}));
  } catch {
    // Storage blocked.
  }
}

interface Owner {
  id: number;
  login: string;
  repos: string[];
}

/** The workspace's owners (the viewer first, then by name) and their repositories (by name). */
function owners(session: Session): Owner[] {
  const {data, userId} = session;
  const ws = data.workspace.current;
  if (!ws) return [];
  const repos = data.pool.model('Repository');
  const users = data.pool.model('User');
  const peek = data.peek('Repository');
  const byId = new Map<number, Owner>();
  const owner = (id: number, login: string | undefined): Owner | undefined => {
    let o = byId.get(id);
    if (!o) {
      const name = login ?? users.get(id)?.get('login');
      if (!name) return undefined;
      byId.set(id, o = {id, login: name, repos: []});
    }
    return o;
  };
  for (const g of ws.groups) {
    const kind = groupKind(g.group);
    const id = groupId(g.group);
    if (kind === 'repo') {
      const e = repos.get(id);
      const r = e ? {owner_id: e.get('owner_id'), owner_name: e.get('owner_name'), name: e.get('name')} : peek.get(id);
      if (r) owner(r.owner_id, r.owner_name)?.repos.push(r.name);
    } else if (kind === 'org' && g.reason === 'member') {
      owner(id, undefined);
    }
  }
  const list = [...byId.values()];
  for (const o of list) o.repos.sort((a, b) => a.localeCompare(b));
  return list.sort((a, b) => Number(b.id === userId) - Number(a.id === userId) || a.login.localeCompare(b.login));
}

/** A repository: its home; current on every page of it (lists, issues, code). */
const RepoItem = memo(function RepoItem({owner, name}: {owner: string; name: string}) {
  const key = `${owner}/${name}`.toLowerCase();
  const current = useRouterState({select: (s) => repoOfPath(s.location.pathname) === key});
  return (
    <NavItem asChild inset label={name}>
      <Link to="/$owner/$repo" params={{owner, repo: name}} activeProps={{}} aria-current={current ? 'page' : undefined}/>
    </NavItem>
  );
});

const OwnerAvatar = observer(function OwnerAvatar({id, login}: {id: number; login: string}) {
  const {data} = useSession();
  const src = data.pool.model('User').get(id)?.get('avatar_url');
  return <Avatar size="sm" name={login} src={src}/>;
});

const sameOwner = (a: {owner: Owner; open: boolean}, b: {owner: Owner; open: boolean}) =>
  a.open === b.open && a.owner.id === b.owner.id && a.owner.login === b.owner.login && a.owner.repos.join('/') === b.owner.repos.join('/');

/** Re-renders only when its owner, repositories or open state change (owners() builds new objects each time). */
const OwnerGroup = memo(function OwnerGroup({owner, open, onToggle}: {owner: Owner; open: boolean; onToggle: (login: string, open: boolean) => void}) {
  const [all, setAll] = useState(false);
  // The repository on screen: its row stays listed (after the first ten, it joins them) and, folded, the owner's
  // row is current in its place: the sidebar always says where you are.
  const prefix = `${owner.login.toLowerCase()}/`;
  const here = useRouterState({select: (s) => {
    const key = repoOfPath(s.location.pathname);
    return key?.startsWith(prefix) ? owner.repos.find((r) => r.toLowerCase() === key.slice(prefix.length)) : undefined;
  }});
  const first = owner.repos.slice(0, SHOWN);
  const shown = all ? owner.repos : here !== undefined && !first.includes(here) ? [...first, here] : first;
  const more = owner.repos.length - shown.length;
  return (
    <NavGroup label={owner.login} leading={<OwnerAvatar id={owner.id} login={owner.login}/>} open={open} holdsCurrent={here !== undefined} onOpenChange={(o) => {
      onToggle(owner.login, o);
    }} link={<Link to="/$owner" params={{owner: owner.login}} activeOptions={{exact: true, includeSearch: false}}/>}>
      {shown.map((name) => <RepoItem key={name} owner={owner.login} name={name}/>)}
      {more > 0 && <NavItem inset label={`${String(more)} more`} onClick={() => {
        setAll(true);
      }}/>}
    </NavGroup>
  );
}, sameOwner);

const Workspace = observer(function Workspace() {
  const session = useSession();
  const [closed, setClosed] = useState(readClosed);
  const toggle = useCallback((login: string, open: boolean) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(login);
      else next.add(login);
      writeClosed(next);
      return next;
    });
  }, []);
  const list = owners(session);
  if (!list.length) return null;
  return (
    <>
      <NavHeading>Workspace</NavHeading>
      {list.map((o) => <OwnerGroup key={o.id} owner={o} open={!closed.has(o.login)} onToggle={toggle}/>)}
    </>
  );
});

/** Saved views: their own chunk (rendered once it is here; below everything else, so nothing moves). */
const SidebarViews = lazyComponent(() => import('../../features/views/SidebarViews.tsx').then((m) => m.SidebarViews));

/** Mounted when the app is idle (the views chunk is not fetched with the first paint). */
function IdleViews() {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    whenIdle(() => {
      setIdle(true);
    });
  }, []);
  return idle ? <SidebarViews/> : null;
}

/** Boards: current on the list of boards and on a board. */
function BoardsItem() {
  const onBoard = useRouterState({select: (s) => s.location.pathname.startsWith('/-/next/projects/')});
  return (
    <NavItem asChild icon={KanbanSquare} label="Boards" shortcut={shortcutHint('go.board')}>
      <Link to="/-/next/boards" {...(onBoard ? {'aria-current': 'page' as const} : {})}/>
    </NavItem>
  );
}

// ── Width ────────────────────────────────────────────────────────────────

function currentWidth(): number {
  const w = readSplash().sidebarWidth;
  if (typeof w === 'number' && Number.isFinite(w)) return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width')) || 232;
}

function SidebarResize() {
  const [width, setWidth] = useState(currentWidth);
  return (
    <ResizeHandle
      label="Resize the sidebar"
      value={width}
      min={SIDEBAR_MIN}
      max={SIDEBAR_MAX}
      onResize={(w, handle) => {
        // While dragging, only the sidebar's own width changes (no React state, and not the
        // root variable, whose change restyles the whole document on every pointer move).
        handle.parentElement?.style.setProperty('width', `${String(w)}px`);
      }}
      onCommit={(w) => {
        document.documentElement.style.setProperty('--sidebar-width', `${String(w)}px`);
        for (const aside of document.querySelectorAll<HTMLElement>('aside[aria-label="Sidebar"]')) aside.style.removeProperty('width');
        writeSplash({sidebarWidth: w});
        setWidth(w);
      }}
    />
  );
}

export function Sidebar() {
  return (
    <>
      <SidebarTop>
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1"><AccountMenu/></div>
          <IconButton size="sm" icon={PanelLeftClose} label="Hide the sidebar" shortcut={shortcutHint('sidebar.toggle')} onClick={toggleSidebar}/>
        </div>
        <SidebarCreate/>
        <SidebarSearch/>
      </SidebarTop>
      <SidebarBody>
        <NavItem asChild icon={Home} label="Home" shortcut={shortcutHint('go.home')}>
          <Link to="/" activeOptions={{exact: true, includeSearch: false}}/>
        </NavItem>
        <InboxItem/>
        <NavItem asChild icon={CircleDot} label="My issues" shortcut={shortcutHint('go.issues')}>
          <Link to="/issues" activeOptions={{includeSearch: false}}/>
        </NavItem>
        <NavItem asChild icon={GitPullRequest} label="My pull requests" shortcut={shortcutHint('go.pulls')}>
          <Link to="/pulls" activeOptions={{includeSearch: false}}/>
        </NavItem>
        <BoardsItem/>
        <Workspace/>
        <IdleViews/>
      </SidebarBody>
      <SidebarResize/>
    </>
  );
}
