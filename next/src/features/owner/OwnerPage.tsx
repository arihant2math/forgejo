// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// An owner — a user or an organization — (/{owner}, a canonical route; the
// classic profile's tabs stay classic): who it is and its repositories, the
// ones on this device at once (pool), the rest from API v1 when online; its
// boards; and the classic pages for what the app does not do (the profile,
// teams, and — for those allowed — settings and a new repository). Its own
// chunk.

import {useParams} from '@tanstack/react-router';
import {Building2, KanbanSquare, Lock, User as UserIcon} from 'lucide-react';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {online} from '../../app/api.ts';
import {ClassicLink} from '../../app/ClassicLink.tsx';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {Missing} from '../../app/Missing.tsx';
import {isOwnerName} from '../../app/paths.ts';
import {ShellNotFound} from '../../app/RouteStatus.tsx';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {Avatar, Badge, EmptyState, Icon, ListRow, Panel, SkeletonText} from '../../ui/index.ts';
import {ago, fullDate} from '../issues/format.ts';

interface OwnerInfo {
  id: number;
  login: string;
  full_name: string;
  avatar_url: string;
  description: string;
  website: string;
  /** API v1 users have no type; organizations are recognised by the org endpoint. */
  org: boolean;
}

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  updated: string;
}

type Remote<T> = {state: 'loading'} | {state: 'ready'; value: T} | {state: 'failed'; status: number};

/** One API v1 read for the page (online only; the pool answers first). */
function useRemote<T>(path: string | undefined): Remote<T> {
  const app = useApp();
  const [state, setState] = useState<{path: string | undefined; r: Remote<T>}>({path, r: {state: 'loading'}});
  if (state.path !== path) setState({path, r: {state: 'loading'}});
  useEffect(() => {
    if (!path) return undefined;
    const ctl = new AbortController();
    online<T>(app, {api: 'v1', path, signal: ctl.signal}).then((value) => {
      if (value !== undefined) setState({path, r: {state: 'ready', value}});
    }, (err: unknown) => {
      if (ctl.signal.aborted) return;
      setState({path, r: {state: 'failed', status: (err as {status?: number}).status ?? 0}});
    });
    return () => {
      ctl.abort();
    };
  }, [app, path]);
  return state.path === path ? state.r : {state: 'loading'};
}

export function OwnerPage() {
  const {owner = ''} = useParams({strict: false});
  // A name Forgejo reserves for its own pages (`/explore`, `/dev.keys`) is no owner.
  if (!isOwnerName(owner)) return <ShellNotFound/>;
  return <OwnerView key={owner} owner={owner}/>;
}

/** What the viewer may do in an organization (API v1; nothing until it answers, nothing offline). */
interface OrgPermissions {
  is_owner: boolean;
  is_admin: boolean;
  can_create_repository: boolean;
}

const OwnerView = observer(function OwnerView({owner}: {owner: string}) {
  const {data, userId} = useSession();
  const users = data.pool.model('User');
  const local = [...users.by('login', owner)][0] ?? [...users.all()].find((u) => u.get('login').toLowerCase() === owner.toLowerCase());
  const remote = useRemote<{id: number; login: string; full_name: string; avatar_url: string; description: string; website: string}>(`/users/${encodeURIComponent(owner)}`);
  // API v1 users have no type: the org endpoint tells, unless the pool knows (a 404 there means a user).
  const orgCheck = useRemote<unknown>(local ? undefined : `/orgs/${encodeURIComponent(owner)}`);
  const info: OwnerInfo | undefined = remote.state === 'ready' ?
    {...remote.value, org: local ? local.get('type') === 'organization' : orgCheck.state === 'ready'} :
    local ? {id: local.id, login: local.get('login'), full_name: local.get('full_name'), avatar_url: local.get('avatar_url'), description: local.get('description'), website: '', org: local.get('type') === 'organization'} :
      undefined;
  const classic = `/${encodeURIComponent(owner)}`;
  if (!info) {
    return (
      <>
        <PageHeader icon={UserIcon} title={owner}/>
        <PageBody>
          {remote.state === 'loading' ? <PageColumn><SkeletonText lines={3}/></PageColumn> :
            <Missing what="This user or organization" classic={remote.state === 'failed' && remote.status === 404 ? undefined : classic}/>}
        </PageBody>
      </>
    );
  }
  const isOrg = info.org || local?.get('type') === 'organization';
  const me = info.id === userId;
  return <OwnerBody info={info} isOrg={isOrg} me={me} classic={classic}/>;
});

const OwnerBody = observer(function OwnerBody({info, isOrg, me, classic}: {info: OwnerInfo; isOrg: boolean; me: boolean; classic: string}) {
  const {data, userId} = useSession();
  const viewer = data.pool.model('User').get(userId)?.get('login');
  const perms = useRemote<OrgPermissions>(isOrg && viewer ? `/users/${encodeURIComponent(viewer)}/orgs/${encodeURIComponent(info.login)}/permissions` : undefined);
  const p = perms.state === 'ready' ? perms.value : undefined;
  // Settings and a new repository only for those allowed (an organization's owners and admins; the user themself).
  const settings = isOrg ? p !== undefined && (p.is_owner || p.is_admin) : me;
  const create = isOrg ? p !== undefined && (p.can_create_repository || p.is_owner) : me;
  return (
    <>
      <PageHeader icon={isOrg ? Building2 : UserIcon} title={info.login}>
        <ClassicLink to={classic} size="sm">{isOrg ? 'Organization page' : 'Profile'}</ClassicLink>
        {isOrg && <ClassicLink to={`/org/${encodeURIComponent(info.login)}/teams`} size="sm">Teams</ClassicLink>}
        {settings && <ClassicLink to={isOrg ? `/org/${encodeURIComponent(info.login)}/settings` : '/user/settings'} size="sm">Settings</ClassicLink>}
      </PageHeader>
      <PageBody>
        <PageColumn>
          <div className="flex items-center gap-3">
            <Avatar size="lg" name={info.login} src={info.avatar_url}/>
            <div className="flex min-w-0 flex-col">
              <h2 className="truncate text-xl font-semibold text-fg">{info.full_name || info.login}</h2>
              <p className="truncate text-base text-fg-muted">{info.full_name ? `${info.login} · ` : ''}{isOrg ? 'Organization' : 'User'}</p>
            </div>
          </div>
          {info.description && <p className="text-md text-fg-muted">{info.description}</p>}
          <Repos owner={info.login} ownerId={info.id} isOrg={isOrg} create={create}/>
          <Boards ownerId={info.id}/>
        </PageColumn>
      </PageBody>
    </>
  );
});

const Repos = observer(function Repos({owner, ownerId, isOrg, create: canCreate}: {owner: string; ownerId: number; isOrg: boolean; create: boolean}) {
  const {data} = useSession();
  const remote = useRemote<{id: number; name: string; owner: {login: string}; description: string; private: boolean; fork: boolean; archived: boolean; updated_at: string}[]>(
    `/users/${encodeURIComponent(owner)}/repos?limit=50`);
  const rows = new Map<number, RepoRow>();
  for (const r of data.pool.model('Repository').by('owner_id', ownerId)) {
    const d = r.data;
    rows.set(d.id, {id: d.id, owner: d.owner_name, name: d.name, description: d.description, private: d.private, fork: d.fork, archived: d.archived, updated: d.updated_at});
  }
  if (remote.state === 'ready') {
    for (const d of remote.value) {
      if (!rows.has(d.id)) rows.set(d.id, {id: d.id, owner: d.owner.login, name: d.name, description: d.description, private: d.private, fork: d.fork, archived: d.archived, updated: d.updated_at});
    }
  }
  const list = [...rows.values()].sort((a, b) => b.updated.localeCompare(a.updated));
  const create = isOrg ? `/repo/create?org=${String(ownerId)}` : '/repo/create';
  return (
    <Panel label="Repositories" title={<>Repositories <span className="tabular-nums">{list.length || ''}</span></>}
      actions={canCreate && <ClassicLink to={create} size="sm">New repository</ClassicLink>}>
      {list.length ? list.map((r) => <RepoLine key={r.id} r={r}/>) :
        remote.state === 'loading' ? <div className="px-3 py-3"><SkeletonText lines={3}/></div> :
          <EmptyState title="No repositories" description="None that you can see."/>}
    </Panel>
  );
});

function RepoLine({r}: {r: RepoRow}) {
  const app = useApp();
  const click = useLinkClick();
  const href = hrefOf(app, `/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`);
  return (
    <ListRow role={undefined} href={href} onClick={(e) => click(e, href)} leading={r.private ? <Icon icon={Lock} size="sm"/> : undefined}
      trailing={<>
        {r.fork && <Badge>Fork</Badge>}
        {r.archived && <Badge tone="warning">Archived</Badge>}
        <time dateTime={r.updated} title={fullDate(r.updated)}>{ago(r.updated)}</time>
      </>}>
      <span className="font-medium">{r.name}</span>{r.description && <span className="text-fg-subtle"> {r.description}</span>}
    </ListRow>
  );
}

/** The owner's boards that are on this device (organization and user projects). */
const Boards = observer(function Boards({ownerId}: {ownerId: number}) {
  const app = useApp();
  const {data} = useSession();
  const click = useLinkClick();
  const boards = [...data.pool.model('Project').by('owner_id', ownerId)].filter((p) => !p.get('repo_id') && !p.get('closed'));
  if (!boards.length) return null;
  return (
    <Panel label="Boards" title={<><Icon icon={KanbanSquare} size="sm"/>Boards</>}>
      {boards.map((b) => {
        const href = hrefOf(app, `/-/next/projects/${String(b.id)}`);
        return <ListRow key={b.id} role={undefined} href={href} onClick={(e) => click(e, href)} leading={<Icon icon={KanbanSquare} size="sm"/>}>{b.get('title')}</ListRow>;
      })}
    </Panel>
  );
});

