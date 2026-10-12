// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {ResourceSection, DataRow, ResourceRows} from '../repo/layout.tsx';
import {Avatar, Heading, UnderlineNav, CounterLabel} from '@primer/react';

import {useNavigate, useParams, useRouter, useSearch} from '@tanstack/react-router';
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
import {NewBoard} from '../board/ProjectDialogs.tsx';
import {agoWords, fullDate} from '../issues/format.ts';
import {OrganizationLabels} from '../meta/OrganizationLabels.tsx';
import {OrganizationPeople, OrganizationTeams} from './Teams.tsx';
import {OfflineNote} from '../settings/bits.tsx';
import {useResource} from '../settings/resource.ts';
import {Follow, Overview, People} from './Profile.tsx';
import {RepoIcon, OrganizationIcon, CloudOfflineIcon, ProjectIcon, LockIcon, GearIcon, PersonIcon, PeopleIcon, KebabHorizontalIcon} from '@primer/octicons-react';
import {Button, LinkButton, ActionMenu, ActionList, Label} from '@primer/react';
import {RouterLinkButton, RouterLink} from '../../app/routerLinks.tsx';
import {SkeletonText, Blankslate} from '@primer/react/experimental';

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
  if (!isOwnerName(owner)) return <ShellNotFound/>;
  return <OwnerView key={owner} owner={owner}/>;
}

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

export type OwnerTab = 'overview' | 'repositories' | 'stars' | 'watching' | 'boards' | 'people' | 'teams';

/** Default to the owner's first tab when the requested tab is unavailable. */
export function ownerTab(raw: unknown, isOrg: boolean, me: boolean): OwnerTab {
  const shown: readonly OwnerTab[] = isOrg ? ['people', 'teams', 'boards', 'repositories'] :
    ['overview', 'boards', 'repositories', 'stars', 'people', ...(me ? ['watching' as const] : [])];
  return shown.find((t) => t === raw) ?? (isOrg ? 'repositories' : 'overview');
}

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
    return <UnderlineNav.Item href={href} aria-current={tab === t ? 'page' : false} onClick={(e) => { click(e, href); }}>{label}</UnderlineNav.Item>;
  };
  const {data, userId} = useSession();
  const viewer = data.pool.model('User').get(userId)?.get('login');
  const perms = useRemote<OrgPermissions>(isOrg && viewer ? `/users/${encodeURIComponent(viewer)}/orgs/${encodeURIComponent(info.login)}/permissions` : undefined);
  const p = perms.state === 'ready' ? perms.value : undefined;
  const settings = isOrg ? p !== undefined && (p.is_owner || p.is_admin) : me;
  const create = isOrg ? p !== undefined && (p.can_create_repository || p.is_owner) : me;
  const navigate = useNavigate();
  const router = useRouter();
  const [section, setSection] = useState<'labels'>();
  return (
    <>
      {/* Keep classic-only actions in More so they fit at phone widths. */}
      <PageHeader icon={isOrg ? OrganizationIcon : PersonIcon} title={info.login}>
        {isOrg && <>
          <Button size="small" type="button" onClick={() => { setSection(section === 'labels' ? undefined : 'labels'); }}>Labels</Button>
        </>}
        <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label={isOrg ? 'More of this organization' : 'More of this user'}>More</ActionMenu.Button><ActionMenu.Overlay><ActionList>
          {isOrg && <>
            <ActionList.Item onSelect={() => void router.navigate({href: tabHref(app, info.login, 'people', true)})}><ActionList.LeadingVisual><PeopleIcon/></ActionList.LeadingVisual>People</ActionList.Item>
            <ActionList.Item onSelect={() => void router.navigate({href: tabHref(app, info.login, 'teams', true)})}><ActionList.LeadingVisual><PeopleIcon/></ActionList.LeadingVisual>Teams</ActionList.Item>
            <ActionList.Divider/>
          </>}
          {settings && !isOrg && <>
            <ActionList.Item onSelect={() => void navigate({to: '/user/settings'})}><ActionList.LeadingVisual><GearIcon/></ActionList.LeadingVisual>Settings</ActionList.Item>
            <ActionList.Divider/>
          </>}
          <ActionList.Group><ActionList.GroupHeading>In the classic UI</ActionList.GroupHeading>
          {isOrg && <ClassicMenuItem to={`/org/${encodeURIComponent(info.login)}/members`} icon={PeopleIcon}>Members</ClassicMenuItem>}
          {settings && isOrg && <ClassicMenuItem to={`/org/${encodeURIComponent(info.login)}/settings`} icon={GearIcon}>Settings</ClassicMenuItem>}
        </ActionList.Group></ActionList></ActionMenu.Overlay></ActionMenu>
      </PageHeader>
      <PageBody>
        <PageColumn>
          <div className="flex items-center gap-4">
            <Avatar size={64} alt={info.login} src={info.avatar_url}/>
            <div className="flex min-w-0 flex-col">
              <Heading as="h2" variant="medium" className="truncate">{info.full_name || info.login}</Heading>
              <p className="truncate text-base text-muted">{info.full_name ? `${info.login} · ` : ''}{isOrg ? 'Organization' : 'User'}</p>
            </div>
          </div>
          {info.description && <p className="text-base text-default">{info.description}</p>}
          {info.location && <p className="text-base text-muted">{info.location}</p>}
          {info.website && /^https?:\/\//i.test(info.website) && <a className="text-base text-accent hover:underline" href={info.website} target="_blank" rel="noreferrer">{info.website}</a>}
          {!isOrg && <>
            <div className="flex gap-2"><LinkButton variant="invisible" size="small" href={tabHref(app, info.login, 'people', false)} onClick={(e) => { click(e, tabHref(app, info.login, 'people', false)); }}>{info.followers_count ?? 0} followers · {info.following_count ?? 0} following</LinkButton></div>
            {!me && <Follow owner={info.login}/>}
          </>}
          {section && <OfflineNote/>}
          {section === 'labels' && <OrganizationLabels owner={info.login}/>}
          <UnderlineNav aria-label="Profile sections">
            {!isOrg && tabLink('overview', 'Overview')}
            {isOrg && tabLink('people', 'People')}
            {isOrg && tabLink('teams', 'Teams')}
            {tabLink('boards', 'Boards')}
            {tabLink('repositories', 'Repositories')}
            {!isOrg && tabLink('stars', 'Stars')}
            {me && !isOrg && tabLink('watching', 'Watching')}
          </UnderlineNav>
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
  // An offline partial repository list must not imply the owner has none.
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
    <ResourceSection label="Repositories" title={<>Repositories <CounterLabel>{list.length}</CounterLabel></>}
      actions={canCreate && (
        <RouterLinkButton variant="invisible" size="small" leadingVisual={RepoIcon} to="/repo/create" search={isOrg ? {org: String(ownerId)} : {}}>New repository</RouterLinkButton>
      )}>
      <ResourceRows>{list.map((r) => <RepoLine key={r.id} r={r}/>)}</ResourceRows>
      {remote.state !== 'ready' && away ?
        list.length ? <p className="px-4 py-2 text-sm text-muted">Repositories that are not on this device load when you are online.</p> :
          <Blankslate><Blankslate.Visual><CloudOfflineIcon size={24}/></Blankslate.Visual><Blankslate.Heading>Not available offline</Blankslate.Heading><Blankslate.Description>This owner’s repositories are not on this device. They load when you are online.</Blankslate.Description></Blankslate> :
        list.length ? null :
          remote.state === 'loading' ? <div className="px-4 py-3"><SkeletonText lines={3}/></div> :
            <Blankslate><Blankslate.Heading>No repositories</Blankslate.Heading><Blankslate.Description>None that you can see.</Blankslate.Description></Blankslate>}
    </ResourceSection>
  );
});

interface APIRepo {id: number; name: string; owner: {login: string}; description: string; private: boolean; fork: boolean; archived: boolean; updated_at: string}

const SocialRepos = observer(function SocialRepos({owner, kind}: {owner: string; kind: 'stars' | 'watching'}) {
  const {data} = useSession();
  const [page, setPage] = useState(1);
  const remote = useRemote<APIRepo[]>(`${kind === 'stars' ? `/users/${encodeURIComponent(owner)}/starred` : '/user/subscriptions'}?limit=50&page=${String(page)}`);
  const away = reach(data.status.connection) !== 'online';
  return <ResourceSection label={kind === 'stars' ? 'Stars' : 'Watching'} title={kind === 'stars' ? 'Starred repositories' : 'Watching repositories'}>
    {kind === 'stars' && <p className="px-4 py-2 text-sm text-muted">Most recently starred first.</p>}
    {remote.state === 'ready' ? <>
      <ResourceRows>{remote.value.map((r) => <RepoLine key={r.id} r={{...r, owner: r.owner.login, fullName: `${r.owner.login}/${r.name}`, updated: r.updated_at}}/> )}</ResourceRows>
      {!remote.value.length && <Blankslate><Blankslate.Heading>No repositories</Blankslate.Heading></Blankslate>}
      <div className="flex gap-2 px-4 py-2"><Button size="small" type="button" disabled={page === 1} onClick={() => { setPage(page - 1); }}>Previous</Button><Button size="small" type="button" disabled={remote.value.length < 50} onClick={() => { setPage(page + 1); }}>Next</Button></div>
    </> : away ? <Blankslate><Blankslate.Heading>Not available offline</Blankslate.Heading><Blankslate.Description>Connect to load these repositories.</Blankslate.Description></Blankslate> : remote.state === 'loading' ? <SkeletonText lines={3}/> : <Blankslate><Blankslate.Heading>Could not load repositories</Blankslate.Heading></Blankslate>}
  </ResourceSection>;
});

function RepoLine({r}: {r: RepoRow}) {
  const app = useApp();
  const click = useLinkClick();
  const href = hrefOf(app, `/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`);
  return (
    // Lead every row with an icon to align names.
    <DataRow href={href} onClick={(e) => click(e, href)} leading={r.private ? <span title="Private" aria-label="Private"><LockIcon size={16} className="shrink-0"/></span> : <RepoIcon size={16} className="shrink-0"/>}
      trailing={<>
        {r.fork && <Label>Fork</Label>}
        {r.archived && <Label variant="attention">Archived</Label>}
        <span>Updated <time dateTime={r.updated} title={fullDate(r.updated)}>{agoWords(r.updated)}</time></span>
      </>}>
      <span className="font-semibold">{r.fullName ?? r.name}</span>{r.description && <span className="ml-2 text-muted">{r.description}</span>}
    </DataRow>
  );
}

const Boards = observer(function Boards({ownerId}: {ownerId: number}) {
  const app = useApp();
  const {data} = useSession();
  const click = useLinkClick();
  const boards = [...data.pool.model('Project').by('owner_id', ownerId)].filter((p) => !p.get('repo_id') && !p.get('closed'));
  return (
    <ResourceSection label="Boards" title={<><ProjectIcon size={16} className="shrink-0"/>Boards</>} actions={<NewBoard scope={{repo_id: 0, owner_id: ownerId}}/>}>
      <RouterLink to="/-/next/boards" search={{ownerId}} muted className="min-w-0 truncate">All boards, including closed</RouterLink>
      {!boards.length && <Blankslate><Blankslate.Heading>No boards on this device</Blankslate.Heading><Blankslate.Description>Boards appear here after they have been synced.</Blankslate.Description></Blankslate>}
      {boards.map((b) => {
        const href = hrefOf(app, `/-/next/projects/${String(b.id)}`);
        return <DataRow key={b.id} href={href} onClick={(e) => click(e, href)} leading={<ProjectIcon size={16} className="shrink-0"/>}>{b.get('title')}</DataRow>;
      })}
    </ResourceSection>
  );
});


