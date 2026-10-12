// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The sidebar: account, search, the viewer's views and the workspace's
// owners and repositories. Each part that reads the pool is its own observer
// leaf, so a delta re-renders the row it changed and nothing else.

import {useRouterState} from '@tanstack/react-router';
import {RouterNavItem} from '../routerLinks.tsx';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {memo, useCallback, useEffect, useState, type MouseEvent} from 'react';
import {groupId, groupKind} from '../../data/models.ts';
import {SidebarSplitter} from './SidebarSplitter.tsx';
import {SkeletonAvatar, KeybindingHint} from '@primer/react/experimental';
import {repoOfPath} from '../paths.ts';
import {KEYMAP} from '../shortcuts/index.ts';
import {LOCAL_PREFS, readSplash, SIDEBAR_MAX, SIDEBAR_MIN, writeSplash} from '../splash.ts';
import {type Session, useApp, useSession} from '../store.ts';
import {openCreate} from '../create.ts';
import {lazyComponent, whenIdle} from '../lazy.tsx';
import {AccountMenu} from './AccountMenu.tsx';
import {SidebarBody, SidebarTop} from './Frame.tsx';
import {toggleSidebar} from './sidebar.ts';
import {IssueOpenedIcon, GitPullRequestIcon, HomeIcon, InboxIcon, ProjectIcon, SidebarExpandIcon, SearchIcon, PencilIcon} from '@primer/octicons-react';
import {Avatar, CounterLabel, IconButton, NavList} from '@primer/react';
import {ChevronDownIcon, ChevronRightIcon, RepoIcon} from '@primer/octicons-react';

/** New issue (C), available from the sidebar and shortcut registry. */
function SidebarCreate() {
  const app = useApp();
  return <NavList.Item as="button" onClick={() => { openCreate(app); }}>
    <NavList.LeadingVisual><PencilIcon/></NavList.LeadingVisual>New issue
    <NavList.TrailingVisual><KeybindingHint keys="c"/></NavList.TrailingVisual>
  </NavList.Item>;
}

const SidebarSearch = function SidebarSearch() {
  const {ui} = useApp();
  return (
    <NavList.Item as="button" onClick={() => {
      runInAction(() => { ui.paletteOpen = true; });
    }}>
      <NavList.LeadingVisual><SearchIcon/></NavList.LeadingVisual>Search
      <NavList.TrailingVisual><KeybindingHint keys="Mod+k"/></NavList.TrailingVisual>
    </NavList.Item>
  );
};

const InboxItem = observer(function InboxItem() {
  const {data} = useSession();
  const {ui} = useApp();
  // The overlay-aware count once the queue runs (a read marked offline counts at once), else the pool's.
  const unread = ui.unread ?? data.pool.model('Notification').by('status', 'unread').size;
  return <RouterNavItem to="/notifications"><NavList.LeadingVisual><InboxIcon/></NavList.LeadingVisual>Inbox{unread > 0 && <NavList.TrailingVisual><CounterLabel>{unread}</CounterLabel></NavList.TrailingVisual>}</RouterNavItem>;
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
export function owners(session: Session, hydrating = false): Owner[] {
  const {data, userId} = session;
  const ws = data.workspace.current;
  if (!ws) return [];
  const repos = data.pool.model('Repository');
  const users = data.pool.model('User');
  const peek = data.peek('Repository');
  const {connection, loading, lastError} = data.status;
  const arriving = hydrating || (lastError === undefined && (
    connection === 'idle' || connection === 'connecting' || connection === 'catching_up' || (connection === 'live' && loading > 0)
  ));
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
      // Missing metadata must not hide known repositories once hydration/sync finishes or fails.
      if (!r) {
        if (arriving) return [];
        continue;
      }
      owner(r.owner_id, r.owner_name)?.repos.push(r.name);
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
    <RouterNavItem to="/$owner/$repo" params={{owner, repo: name}} activeProps={{}} aria-current={current ? 'page' : false} className="ml-4">
      <NavList.LeadingVisual><RepoIcon/></NavList.LeadingVisual>{name}
    </RouterNavItem>
  );
});

const OwnerAvatar = observer(function OwnerAvatar({id, login}: {id: number; login: string}) {
  const {data} = useSession();
  const src = data.pool.model('User').get(id)?.get('avatar_url');
  return src ? <Avatar size={20} alt="" src={src}/> : <SkeletonAvatar size={20} aria-label={login}/>;
});

const sameOwner = (a: {owner: Owner; open: boolean}, b: {owner: Owner; open: boolean}) =>
  a.open === b.open && a.owner.id === b.owner.id && a.owner.login === b.owner.login && a.owner.repos.join('/') === b.owner.repos.join('/');

/** Re-renders only when its owner, repositories or open state change (owners() builds new objects each time). */
export const OwnerGroup = memo(function OwnerGroup({owner, open, onToggle}: {owner: Owner; open: boolean; onToggle: (login: string, open: boolean) => void}) {
  const [all, setAll] = useState(false);
  // The repository on screen: its row stays listed (after the first ten, it joins them) and, folded, the owner's
  // row is current in its place: the sidebar always says where you are.
  const prefix = `${owner.login.toLowerCase()}/`;
  const here = useRouterState({select: (s) => {
    const key = repoOfPath(s.location.pathname);
    return key?.startsWith(prefix) ? owner.repos.find((r) => r.toLowerCase() === key.slice(prefix.length)) : undefined;
  }});
  const first = owner.repos.slice(0, SHOWN);
  const [visited, setVisited] = useState<string[]>([]);
  // Retain revealed rows after navigation so subsequent clicks cannot hit a shifted row.
  if (here !== undefined && !first.includes(here) && !visited.includes(here)) {
    setVisited([...visited, here]);
  }
  const extra = visited.filter((name) => owner.repos.includes(name) && !first.includes(name));
  const shown = all ? owner.repos : [...first, ...extra];
  const more = owner.repos.length - shown.length;
  return (
    <NavList.Group hideDivider role="group" aria-label={owner.login}>
      <RouterNavItem to="/$owner" params={{owner: owner.login}} activeOptions={{exact: true, includeSearch: false}} {...(!open && here !== undefined ? {'aria-current': 'location' as const} : {})}>
        <NavList.LeadingVisual><OwnerAvatar id={owner.id} login={owner.login}/></NavList.LeadingVisual>
        {owner.login}
        <NavList.TrailingAction
          icon={open ? ChevronDownIcon : ChevronRightIcon}
          label={`${open ? 'Collapse' : 'Expand'} ${owner.login}`}
          aria-expanded={open}
          onClick={(event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); onToggle(owner.login, !open); }}
        />
      </RouterNavItem>
      {open && shown.map((name) => <RepoItem key={name} owner={owner.login} name={name}/>)}
      {open && more > 0 && <NavList.Item as="button" className="ml-4" onClick={() => { setAll(true); }}>{String(more)} more</NavList.Item>}
    </NavList.Group>
  );
}, sameOwner);

const Workspace = observer(function Workspace() {
  const session = useSession();
  const [closed, setClosed] = useState(readClosed);
  const [hydrating, setHydrating] = useState(true);
  useEffect(() => {
    let mounted = true;
    const done = () => {
      if (mounted) setHydrating(false);
    };
    void session.data.hydrated.then(done, done);
    return () => { mounted = false; };
  }, [session]);
  const toggle = useCallback((login: string, open: boolean) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(login);
      else next.add(login);
      writeClosed(next);
      return next;
    });
  }, []);
  const list = owners(session, hydrating);
  if (!list.length) return null;
  return (
    <>
      <NavList.GroupHeading as="h2">Workspace</NavList.GroupHeading>
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
    // The idle callback can come after an unmount (a closed test environment
    // too, where React's update then reads a `window` that is gone).
    let live = true;
    whenIdle(() => {
      if (live) setIdle(true);
    });
    return () => {
      live = false;
    };
  }, []);
  return idle ? <SidebarViews/> : null;
}

/** Boards: current on the list of boards and on a board. */
function BoardsItem() {
  const onBoard = useRouterState({select: (s) => s.location.pathname.startsWith('/-/next/projects/')});
  return (
    <RouterNavItem to="/-/next/boards" {...(onBoard ? {'aria-current': 'page' as const} : {})}>
      <NavList.LeadingVisual><ProjectIcon/></NavList.LeadingVisual>Boards
    </RouterNavItem>
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
    <SidebarSplitter
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
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 pl-2"><AccountMenu/></div>
          <IconButton icon={SidebarExpandIcon} variant="invisible" size="small" aria-label="Hide the sidebar" description="Hide the sidebar" keybindingHint={KEYMAP['sidebar.toggle'].keys} type="button" onClick={toggleSidebar}/>
        </div>
        <NavList aria-label="Quick actions"><SidebarCreate/><SidebarSearch/></NavList>
      </SidebarTop>
      <SidebarBody>
        <NavList aria-label="Main">
          <RouterNavItem to="/" activeOptions={{exact: true, includeSearch: false}}><NavList.LeadingVisual><HomeIcon/></NavList.LeadingVisual>Home</RouterNavItem>
          <InboxItem/>
          <RouterNavItem to="/issues" activeOptions={{includeSearch: false}}><NavList.LeadingVisual><IssueOpenedIcon/></NavList.LeadingVisual>My issues</RouterNavItem>
          <RouterNavItem to="/pulls" activeOptions={{includeSearch: false}}><NavList.LeadingVisual><GitPullRequestIcon/></NavList.LeadingVisual>My pull requests</RouterNavItem>
          <RouterNavItem to="/explore" search={{q: '', type: 'repositories', sort: 'updated', state: 'all', archived: '', language: '', page: 1}} activeOptions={{includeSearch: false}}><NavList.LeadingVisual><SearchIcon/></NavList.LeadingVisual>Explore</RouterNavItem>
          <BoardsItem/>
          <Workspace/>
        </NavList>
        <IdleViews/>
      </SidebarBody>
      <SidebarResize/>
    </>
  );
}
