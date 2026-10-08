// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The sidebar: account, search, the viewer's views and the workspace's
// owners and repositories. Each part that reads the pool is its own observer
// leaf, so a delta re-renders the row it changed and nothing else.

import {Link} from '@tanstack/react-router';
import {CircleDot, GitPullRequest, Inbox, Search} from 'lucide-react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {memo, useState} from 'react';
import {groupId, groupKind} from '../../data/models.ts';
import {Avatar, NavGroup, NavHeading, NavItem, ResizeHandle} from '../../ui/index.ts';
import {shortcutHint} from '../shortcuts/index.ts';
import {readSplash, SIDEBAR_MAX, SIDEBAR_MIN, writeSplash} from '../splash.ts';
import {type Session, useApp, useSession} from '../store.ts';
import {AccountMenu} from './AccountMenu.tsx';
import {SidebarBody, SidebarTop} from './Frame.tsx';

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
  const unread = data.pool.model('Notification').by('status', 'unread').size;
  return <NavItem asChild icon={Inbox} label="Inbox" count={unread} shortcut={shortcutHint('go.inbox')}><Link to="/notifications"/></NavItem>;
});

// ── Workspace: owners and their repositories ─────────────────────────────

const PREFS = 'forgejo-next:sidebar';
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

const RepoItem = memo(function RepoItem({owner, name}: {owner: string; name: string}) {
  return (
    <NavItem asChild inset label={name}>
      <Link to="/$owner/$repo/issues" params={{owner, repo: name}} activeOptions={{includeSearch: false, exact: false}}/>
    </NavItem>
  );
});

const OwnerAvatar = observer(function OwnerAvatar({id, login}: {id: number; login: string}) {
  const {data} = useSession();
  const src = data.pool.model('User').get(id)?.get('avatar_url');
  return <Avatar size="sm" name={login} src={src}/>;
});

function OwnerGroup({owner, open, onOpenChange}: {owner: Owner; open: boolean; onOpenChange: (open: boolean) => void}) {
  const [all, setAll] = useState(false);
  const shown = all ? owner.repos : owner.repos.slice(0, SHOWN);
  const more = owner.repos.length - shown.length;
  return (
    <NavGroup label={owner.login} leading={<OwnerAvatar id={owner.id} login={owner.login}/>} open={open} onOpenChange={onOpenChange}>
      {shown.map((name) => <RepoItem key={name} owner={owner.login} name={name}/>)}
      {more > 0 && <NavItem inset label={`${String(more)} more`} onClick={() => {
        setAll(true);
      }}/>}
    </NavGroup>
  );
}

const Workspace = observer(function Workspace() {
  const session = useSession();
  const [closed, setClosed] = useState(readClosed);
  const list = owners(session);
  if (!list.length) return null;
  const toggle = (login: string, open: boolean) => {
    const next = new Set(closed);
    if (open) next.delete(login);
    else next.add(login);
    writeClosed(next);
    setClosed(next);
  };
  return (
    <>
      <NavHeading>Workspace</NavHeading>
      {list.map((o) => <OwnerGroup key={o.id} owner={o} open={!closed.has(o.login)} onOpenChange={(open) => {
        toggle(o.login, open);
      }}/>)}
    </>
  );
});

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
      onResize={(w) => {
        // No React state while dragging: only the CSS variable the layout reads.
        document.documentElement.style.setProperty('--sidebar-width', `${String(w)}px`);
      }}
      onCommit={(w) => {
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
        <AccountMenu/>
        <SidebarSearch/>
      </SidebarTop>
      <SidebarBody>
        <InboxItem/>
        <NavItem asChild icon={CircleDot} label="My issues" shortcut={shortcutHint('go.issues')}>
          <Link to="/issues" activeOptions={{includeSearch: false}}/>
        </NavItem>
        <NavItem asChild icon={GitPullRequest} label="My pull requests" shortcut={shortcutHint('go.pulls')}>
          <Link to="/pulls" activeOptions={{includeSearch: false}}/>
        </NavItem>
        <Workspace/>
      </SidebarBody>
      <SidebarResize/>
    </>
  );
}
