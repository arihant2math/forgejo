// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// User profiles and organizations on the canonical /{owner} route.

import {LinkRows} from '../../ui/LinkRows.tsx';
import {Link, useNavigate, useParams, useRouter, useSearch} from '@tanstack/react-router';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {online} from '../../app/api.ts';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {Missing} from '../../app/Missing.tsx';
import {reach} from '../../app/online.ts';
import {isOwnerName} from '../../app/paths.ts';
import {ShellNotFound} from '../../app/RouteStatus.tsx';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {Avatar, Badge, EmptyState, Hint, ListRow, MenuItem, MenuLabel, MenuSeparator, MoreMenu, Panel, SkeletonText, TabNav, TabLink, TextLink} from '../../ui/index.ts';
import {NewBoard} from '../board/ProjectDialogs.tsx';
import {agoWords, fullDate} from '../issues/format.ts';
import {OrganizationLabels} from '../meta/OrganizationLabels.tsx';
import {OrganizationPeople, OrganizationTeams} from './Teams.tsx';
import {OfflineNote} from '../settings/bits.tsx';
import {useResource} from '../settings/resource.ts';
import {Follow, Overview, People} from './Profile.tsx';
import {RepoIcon, OrganizationIcon, CloudOfflineIcon, ProjectIcon, LockIcon, GearIcon, PersonIcon, PeopleIcon} from '@primer/octicons-react';
import {Button, LinkButton} from '@primer/react';
import {RouterLinkButton} from '../../app/RouterLinkButton.tsx';

interface OwnerInfo {
  id: number;
  login: string;
  full_name: string;
  avatar_url: string;
  description: string;
  website: string;
  location?: string;
  followers_count?: number;
  following_count?: number;
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
  fullName?: string;
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
  const navigate = useNavigate();
  const users = data.pool.model('User');
  const local = [...users.by('login', owner)][0] ?? [...users.all()].find((u) => u.get('login').toLowerCase() === owner.toLowerCase());
  const app = useApp();
  const profile = useResource(`profile:${owner}`, async (signal) => {
    const value = await online<Omit<OwnerInfo, 'org'> & {bio?: string}>(app, {api: 'v1', path: `/users/${encodeURIComponent(owner)}`, signal});
    if (!value) throw new Error('Profile unavailable');
    return {...value, description: value.bio ?? value.description};
  });
  const remote: Remote<NonNullable<typeof profile.value>> = profile.value ? {state: 'ready', value: profile.value} : profile.state === 'loading' ? {state: 'loading'} : {state: 'failed', status: profile.status ?? 0};
  // API v1 users have no type: the org endpoint tells, unless the pool knows (a 404 there means a user).
  const orgCheck = useRemote<unknown>(local ? undefined : `/orgs/${encodeURIComponent(owner)}`);
  const info: OwnerInfo | undefined = remote.state === 'ready' ?
    {...remote.value, org: local ? local.get('type') === 'organization' : orgCheck.state === 'ready'} :
    local ? {id: local.id, login: local.get('login'), full_name: local.get('full_name'), avatar_url: local.get('avatar_url'), description: local.get('description'), website: '', org: local.get('type') === 'organization'} :
      undefined;
  const login = info?.login;
  useEffect(() => {
    if (login && login !== owner) void navigate({to: '/$owner', params: {owner: login}, search: true, hash: true, replace: true});
  }, [login, owner, navigate]);
  const classic = `/${encodeURIComponent(login ?? owner)}`;
  if (!info) {
    return (
      <>
        <PageHeader icon={PersonIcon} title={owner}/>
        <PageBody>
          {remote.state === 'loading' ? <PageColumn><SkeletonText lines={3}/></PageColumn> :
            <Missing what="This user or organization" classic={remote.state === 'failed' && remote.status === 404 ? undefined : classic}/>}
        </PageBody>
      </>
    );
  }
  const isOrg = info.org || local?.get('type') === 'organization';
  const me = info.id === userId;
  return <OwnerBody key={isOrg ? 'org' : 'user'} info={info} isOrg={isOrg} me={me}/>;
});

/**
 * The owner page's sections, each its own address (`/{owner}?tab=stars`, the classic profile's parameter; spa.go
 * serves the app for these tabs and the classic page for the others).
 */
export type OwnerTab = 'overview' | 'repositories' | 'stars' | 'watching' | 'boards' | 'people' | 'teams';

/** The section a `tab` parameter asks for, as far as this owner has it; its first section otherwise. */
export function ownerTab(raw: unknown, isOrg: boolean, me: boolean): OwnerTab {
  const shown: readonly OwnerTab[] = isOrg ? ['people', 'teams', 'boards', 'repositories'] :
    ['overview', 'boards', 'repositories', 'stars', 'people', ...(me ? ['watching' as const] : [])];
  return shown.find((t) => t === raw) ?? (isOrg ? 'repositories' : 'overview');
}

/** A section's address (the first section's is the bare profile). */
function tabHref(app: ReturnType<typeof useApp>, owner: string, tab: OwnerTab, isOrg: boolean): string {
  const first = isOrg ? 'repositories' : 'overview';
  return hrefOf(app, `/${encodeURIComponent(owner)}${tab === first ? '' : `?tab=${tab}`}`);
}

const OwnerBody = observer(function OwnerBody({info, isOrg, me}: {info: OwnerInfo; isOrg: boolean; me: boolean}) {
  const search = useSearch({strict: false}) as Record<string, unknown>;
  const tab = ownerTab(search.tab, isOrg, me);
  const app = useApp();
  const click = useLinkClick();
  const tabLink = (t: OwnerTab, label: string) => {
    const href = tabHref(app, info.login, t, isOrg);
    return <TabLink><a href={href} aria-current={tab === t ? 'page' : undefined} onClick={(e) => { click(e, href); }}>{label}</a></TabLink>;
  };
  const {data, userId} = useSession();
  const viewer = data.pool.model('User').get(userId)?.get('login');
  const perms = useRemote<OrgPermissions>(isOrg && viewer ? `/users/${encodeURIComponent(viewer)}/orgs/${encodeURIComponent(info.login)}/permissions` : undefined);
  const p = perms.state === 'ready' ? perms.value : undefined;
  // Settings and a new repository only for those allowed (an organization's owners and admins; the user themself).
  const settings = isOrg ? p !== undefined && (p.is_owner || p.is_admin) : me;
  const create = isOrg ? p !== undefined && (p.can_create_repository || p.is_owner) : me;
  const navigate = useNavigate();
  const router = useRouter();
  const [section, setSection] = useState<'labels'>();
  return (
    <>
      {/* What only the classic UI has is in More, as on a repository's pages (buttons ran off a phone's edge). */}
      <PageHeader icon={isOrg ? OrganizationIcon : PersonIcon} title={info.login}>
        {isOrg && <>
          <Button size="small" type="button" onClick={() => { setSection(section === 'labels' ? undefined : 'labels'); }}>Labels</Button>
        </>}
        <MoreMenu label={isOrg ? 'More of this organization' : 'More of this user'}>
          {isOrg && <>
            <MenuItem icon={PeopleIcon} onSelect={() => void router.navigate({href: tabHref(app, info.login, 'people', true)})}>People</MenuItem>
            <MenuItem icon={PeopleIcon} onSelect={() => void router.navigate({href: tabHref(app, info.login, 'teams', true)})}>Teams</MenuItem>
            <MenuSeparator/>
          </>}
          {settings && !isOrg && <>
            <MenuItem icon={GearIcon} onSelect={() => void navigate({to: '/user/settings'})}>Settings</MenuItem>
            <MenuSeparator/>
          </>}
          <MenuLabel>In the classic UI</MenuLabel>
          {isOrg && <ClassicMenuItem to={`/org/${encodeURIComponent(info.login)}/members`} icon={PeopleIcon}>Members</ClassicMenuItem>}
          {settings && isOrg && <ClassicMenuItem to={`/org/${encodeURIComponent(info.login)}/settings`} icon={GearIcon}>Settings</ClassicMenuItem>}
        </MoreMenu>
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
          {info.location && <p className="text-sm text-fg-muted">{info.location}</p>}
          {info.website && /^https?:\/\//i.test(info.website) && <a className="text-sm text-accent" href={info.website} target="_blank" rel="noreferrer">{info.website}</a>}
          {!isOrg && <>
            <div className="flex gap-3"><LinkButton variant="invisible" size="small" href={tabHref(app, info.login, 'people', false)} onClick={(e) => { click(e, tabHref(app, info.login, 'people', false)); }}>{info.followers_count ?? 0}followers · {info.following_count ?? 0}following</LinkButton></div>
            {!me && <Follow owner={info.login}/>}
          </>}
          {section && <OfflineNote/>}
          {section === 'labels' && <OrganizationLabels owner={info.login}/>}
          <TabNav label="Profile sections">
            {!isOrg && tabLink('overview', 'Overview')}
            {isOrg && tabLink('people', 'People')}
            {isOrg && tabLink('teams', 'Teams')}
            {tabLink('boards', 'Boards')}
            {tabLink('repositories', 'Repositories')}
            {!isOrg && tabLink('stars', 'Stars')}
            {me && !isOrg && tabLink('watching', 'Watching')}
          </TabNav>
          {tab === 'repositories' && <Repos owner={info.login} ownerId={info.id} isOrg={isOrg} create={create}/>}
          {tab === 'overview' && <Overview owner={info.login}/>}
          {tab === 'boards' && <Boards ownerId={info.id}/>}
          {tab === 'people' && (isOrg ? <OrganizationPeople owner={info.login}/> : <People owner={info.login} isOrg={false}/>)}
          {tab === 'teams' && <OrganizationTeams owner={info.login}/>}
          {(tab === 'stars' || tab === 'watching') && <SocialRepos key={tab} owner={info.login} kind={tab}/>}
        </PageColumn>
      </PageBody>
    </>
  );
});

const Repos = observer(function Repos({owner, ownerId, isOrg, create: canCreate}: {owner: string; ownerId: number; isOrg: boolean; create: boolean}) {
  const {data} = useSession();
  // Offline (or Forgejo not answering) only the repositories this device has are listed: say so, never "none".
  const away = reach(data.status.connection) !== 'online';
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
  return (
    <Panel label="Repositories" title={<>Repositories <span className="tabular-nums">{list.length || ''}</span></>}
      actions={canCreate && (
        <RouterLinkButton variant="invisible" size="small" leadingVisual={RepoIcon} to="/repo/create" search={isOrg ? {org: String(ownerId)} : {}}>New repository</RouterLinkButton>
      )}>
      <LinkRows>{list.map((r) => <RepoLine key={r.id} r={r}/>)}</LinkRows>
      {remote.state !== 'ready' && away ?
        list.length ? <p className="px-3 py-2 text-sm text-fg-subtle">Repositories that are not on this device load when you are online.</p> :
          <EmptyState icon={CloudOfflineIcon} title="Not available offline" description="This owner’s repositories are not on this device. They load when you are online."/> :
        list.length ? null :
          remote.state === 'loading' ? <div className="px-3 py-3"><SkeletonText lines={3}/></div> :
            <EmptyState title="No repositories" description="None that you can see."/>}
    </Panel>
  );
});

interface APIRepo {id: number; name: string; owner: {login: string}; description: string; private: boolean; fork: boolean; archived: boolean; updated_at: string}

const SocialRepos = observer(function SocialRepos({owner, kind}: {owner: string; kind: 'stars' | 'watching'}) {
  const {data} = useSession();
  const [page, setPage] = useState(1);
  const remote = useRemote<APIRepo[]>(`${kind === 'stars' ? `/users/${encodeURIComponent(owner)}/starred` : '/user/subscriptions'}?limit=50&page=${String(page)}`);
  const away = reach(data.status.connection) !== 'online';
  return <Panel label={kind === 'stars' ? 'Stars' : 'Watching'} title={kind === 'stars' ? 'Starred repositories' : 'Watching repositories'}>
    {kind === 'stars' && <p className="px-3 py-1 text-sm text-fg-muted">Most recently starred first.</p>}
    {remote.state === 'ready' ? <>
      <LinkRows>{remote.value.map((r) => <RepoLine key={r.id} r={{...r, owner: r.owner.login, fullName: `${r.owner.login}/${r.name}`, updated: r.updated_at}}/> )}</LinkRows>
      {!remote.value.length && <EmptyState title="No repositories"/>}
      <div className="flex gap-2 px-3 py-2"><Button size="small" type="button" disabled={page === 1} onClick={() => { setPage(page - 1); }}>Previous</Button><Button size="small" type="button" disabled={remote.value.length < 50} onClick={() => { setPage(page + 1); }}>Next</Button></div>
    </> : away ? <EmptyState title="Not available offline" description="Connect to load these repositories."/> : remote.state === 'loading' ? <SkeletonText lines={3}/> : <EmptyState title="Could not load repositories"/>}
  </Panel>;
});

function RepoLine({r}: {r: RepoRow}) {
  const app = useApp();
  const click = useLinkClick();
  const href = hrefOf(app, `/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`);
  return (
    // Every row leads with an icon (a lock for a private one), so that the names line up.
    <ListRow role={undefined} href={href} onClick={(e) => click(e, href)} leading={r.private ? <Hint label="Private"><LockIcon size={12} className="shrink-0"/></Hint> : <RepoIcon size={12} className="shrink-0"/>}
      trailing={<>
        {r.fork && <Badge>Fork</Badge>}
        {r.archived && <Badge tone="warning">Archived</Badge>}
        <span>Updated <time dateTime={r.updated} title={fullDate(r.updated)}>{agoWords(r.updated)}</time></span>
      </>}>
      <span className="font-medium">{r.fullName ?? r.name}</span>{r.description && <span className="ml-3 text-fg-subtle">{r.description}</span>}
    </ListRow>
  );
}

/** The owner's boards that are on this device (organization and user projects). */
const Boards = observer(function Boards({ownerId}: {ownerId: number}) {
  const app = useApp();
  const {data} = useSession();
  const click = useLinkClick();
  const boards = [...data.pool.model('Project').by('owner_id', ownerId)].filter((p) => !p.get('repo_id') && !p.get('closed'));
  return (
    <Panel label="Boards" title={<><ProjectIcon size={12} className="shrink-0"/>Boards</>} actions={<NewBoard scope={{repo_id: 0, owner_id: ownerId}}/>}>
      <TextLink><Link to="/-/next/boards" search={{ownerId}}>All boards, including closed</Link></TextLink>
      {!boards.length && <EmptyState title="No boards on this device" description="Boards appear here after they have been synced."/>}
      {boards.map((b) => {
        const href = hrefOf(app, `/-/next/projects/${String(b.id)}`);
        return <ListRow key={b.id} role={undefined} href={href} onClick={(e) => click(e, href)} leading={<ProjectIcon size={12} className="shrink-0"/>}>{b.get('title')}</ListRow>;
      })}
    </Panel>
  );
});

