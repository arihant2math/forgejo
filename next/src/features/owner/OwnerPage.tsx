// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {ResourceSection, DataRow, ResourceRows} from '../repo/layout.tsx';
import {Avatar, Heading, UnderlineNav, Pagination, Dialog} from '@primer/react';

import {useNavigate, useParams, useSearch} from '@tanstack/react-router';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';
import {online, RequestFailed, send} from '../../app/api.ts';
import {hrefOf, useLinkClick} from '../../app/links.ts';
import {Missing} from '../../app/Missing.tsx';
import {reach} from '../../app/online.ts';
import {isOwnerName} from '../../app/paths.ts';
import {ShellNotFound} from '../../app/RouteStatus.tsx';
import {PageBody, PageColumn} from '../../app/shell/Frame.tsx';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {type App, useApp, useSession} from '../../app/store.ts';
import {NewBoard} from '../board/ProjectDialogs.tsx';
import {TimeAgo} from '../../components/TimeAgo.tsx';
import {OrganizationLabels} from '../meta/OrganizationLabels.tsx';
import {OrganizationPeople, OrganizationTeams, useOrgPermissions} from './Teams.tsx';
import {useResource, type Resource} from '../settings/resource.ts';
import {Follow, Overview, People} from './Profile.tsx';
import {RepoIcon, OrganizationIcon, CloudOfflineIcon, ProjectIcon, LockIcon, GearIcon, PersonIcon, PeopleIcon, KebabHorizontalIcon, TagIcon} from '@primer/octicons-react';
import {ActionMenu, ActionList, Label} from '@primer/react';
import {RouterLinkButton, RouterLink} from '../../app/routerLinks.tsx';
import {SkeletonText} from '@primer/react/experimental';
import {EmptyState} from '../../components/EmptyState.tsx';

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
  starred_repos_count?: number;
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

interface APIRepo {id: number; name: string; owner: {login: string}; description: string; private: boolean; fork: boolean; archived: boolean; updated_at: string}

interface RepoPage {rows: APIRepo[]; total: number | undefined}

const PER_PAGE = 30;

function pageOf(raw: unknown): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 1 ? n : 1;
}

export function OwnerPage() {
  const {owner = ''} = useParams({strict: false});
  if (!isOwnerName(owner)) return <ShellNotFound/>;
  return <OwnerView key={owner} owner={owner}/>;
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
  // API v1 users have no type: the org endpoint tells, unless the pool knows (a 404 there means a user).
  const orgCheck = useResource(`owner-org:${owner}`, async (signal) => {
    if (local) return local.get('type') === 'organization';
    try {
      await online(app, {api: 'v1', path: `/orgs/${encodeURIComponent(owner)}`, signal});
      return true;
    } catch (err) {
      if (err instanceof RequestFailed && err.status === 404) return false;
      throw err;
    }
  });
  const info: OwnerInfo | undefined = profile.value ?
    {...profile.value, org: local ? local.get('type') === 'organization' : orgCheck.value === true} :
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
          {profile.state === 'loading' ? <PageColumn><SkeletonText lines={3}/></PageColumn> :
            <Missing what="This user or organization" classic={profile.status === 404 ? undefined : classic}/>}
        </PageBody>
      </>
    );
  }
  const isOrg = info.org || local?.get('type') === 'organization';
  const me = info.id === userId;
  return <OwnerBody key={isOrg ? 'org' : 'user'} info={info} isOrg={isOrg} me={me}/>;
});

/** spa.go serves these owner tabs in the app; other tabs remain classic-only. */
export type OwnerTab = 'overview' | 'repositories' | 'stars' | 'watching' | 'boards' | 'people' | 'teams';

/** GitHub's tab order; organizations have no overview, so their repositories come first. */
export function ownerTabs(isOrg: boolean, me: boolean): readonly OwnerTab[] {
  return isOrg ? ['repositories', 'boards', 'teams', 'people'] :
    ['overview', 'repositories', 'boards', 'stars', 'people', ...(me ? ['watching' as const] : [])];
}

export function ownerTab(raw: unknown, isOrg: boolean, me: boolean): OwnerTab {
  const shown = ownerTabs(isOrg, me);
  return shown.find((t) => t === raw) ?? shown[0] ?? 'overview';
}

const TAB_LABELS: Record<OwnerTab, string> = {overview: 'Overview', repositories: 'Repositories', boards: 'Boards', stars: 'Stars', people: 'People', watching: 'Watching', teams: 'Teams'};

function tabHref(app: App, owner: string, tab: OwnerTab, isOrg: boolean, page = 1): string {
  const query = new URLSearchParams();
  if (tab !== ownerTabs(isOrg, false)[0]) query.set('tab', tab);
  if (page > 1) query.set('page', String(page));
  const q = query.toString();
  return hrefOf(app, `/${encodeURIComponent(owner)}${q ? `?${q}` : ''}`);
}

const OwnerBody = observer(function OwnerBody({info, isOrg, me}: {info: OwnerInfo; isOrg: boolean; me: boolean}) {
  const search = useSearch({strict: false}) as Record<string, unknown>;
  const tab = ownerTab(search.tab, isOrg, me);
  const app = useApp();
  const click = useLinkClick();
  const perms = useOrgPermissions(isOrg ? info.login : '');
  const p = perms.value;
  const settings = isOrg && p !== undefined && (p.is_owner || p.is_admin);
  const create = isOrg ? p !== undefined && (p.can_create_repository === true || p.is_owner) : me;
  const [labels, setLabels] = useState(false);
  const page = tab === 'repositories' ? pageOf(search.page) : 1;
  // The Repositories tab's counter needs the total on every tab; its first page doubles as a prefetch.
  const repos = useResource(`owner-repos:${String(info.id)}:${String(page)}`, async (signal): Promise<RepoPage> => {
    const query = new URLSearchParams({uid: String(info.id), exclusive: 'true', sort: 'updated', order: 'desc', limit: String(PER_PAGE), page: String(page)});
    const r = await send<{data?: APIRepo[]}>(app, {api: 'v1', path: `/repos/search?${query}`, signal});
    return {rows: r.value?.data ?? [], total: r.totalCount};
  });
  const counters: Partial<Record<OwnerTab, number | undefined>> = {repositories: repos.value?.total, stars: info.starred_repos_count};
  const tabLink = (t: OwnerTab) => {
    const href = tabHref(app, info.login, t, isOrg);
    const count = counters[t];
    return <UnderlineNav.Item key={t} href={href} aria-current={tab === t ? 'page' : false} {...(count === undefined ? {} : {counter: count})} onClick={(e) => { click(e, href); }}>{TAB_LABELS[t]}</UnderlineNav.Item>;
  };
  const followers = tabHref(app, info.login, 'people', false);
  return (
    <>
      <PageHeader icon={isOrg ? OrganizationIcon : PersonIcon} title={info.login}>
        {isOrg && <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label="More of this organization">More</ActionMenu.Button><ActionMenu.Overlay><ActionList>
          <ActionList.Item onSelect={() => { setLabels(true); }}><ActionList.LeadingVisual><TagIcon/></ActionList.LeadingVisual>Labels</ActionList.Item>
          <ActionList.Divider/>
          <ActionList.Group><ActionList.GroupHeading>In the classic UI</ActionList.GroupHeading>
            <ClassicMenuItem to={`/org/${encodeURIComponent(info.login)}/members`} icon={PeopleIcon}>Members</ClassicMenuItem>
            {settings && <ClassicMenuItem to={`/org/${encodeURIComponent(info.login)}/settings`} icon={GearIcon}>Settings</ClassicMenuItem>}
          </ActionList.Group>
        </ActionList></ActionMenu.Overlay></ActionMenu>}
      </PageHeader>
      {labels && <Dialog title={`Labels of ${info.login}`} width="xlarge" onClose={() => { setLabels(false); }}><OrganizationLabels owner={info.login}/></Dialog>}
      <PageBody>
        <PageColumn>
          <div className="flex items-center gap-4">
            <Avatar size={64} alt={info.login} src={info.avatar_url}/>
            <div className="flex min-w-0 flex-col">
              <Heading as="h2" variant="medium" className="truncate">{info.full_name || info.login}</Heading>
              <p className="truncate text-base text-muted">{info.full_name ? `${info.login} · ` : ''}{isOrg ? 'Organization' : 'User'}</p>
            </div>
          </div>
          {!isOrg && (me ? <RouterLinkButton to="/user/settings" block>Edit profile</RouterLinkButton> : <Follow owner={info.login}/>)}
          {info.description && <p className="text-base text-default">{info.description}</p>}
          {info.location && <p className="text-base text-muted">{info.location}</p>}
          {info.website && /^https?:\/\//i.test(info.website) && <a className="text-base text-accent hover:underline" href={info.website} target="_blank" rel="noreferrer">{info.website}</a>}
          {!isOrg && <a className="flex items-center gap-1 text-base text-muted hover:text-accent" href={followers} onClick={(e) => { click(e, followers); }}>
            <PeopleIcon size={16}/><span className="font-semibold text-default">{info.followers_count ?? 0}</span> followers · <span className="font-semibold text-default">{info.following_count ?? 0}</span> following
          </a>}
          <UnderlineNav aria-label="Profile sections">
            {ownerTabs(isOrg, me).map(tabLink)}
          </UnderlineNav>
          {tab === 'repositories' && <Repos owner={info.login} ownerId={info.id} isOrg={isOrg} create={create} res={repos} page={page}/>}
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

function Pages({total, page, href}: {total: number; page: number; href: (n: number) => string}) {
  const click = useLinkClick();
  const count = Math.ceil(total / PER_PAGE);
  if (count <= 1) return null;
  return <Pagination pageCount={count} currentPage={Math.min(page, count)} hrefBuilder={href} onPageChange={(e, n) => { click(e, href(n)); }}/>;
}

const Repos = observer(function Repos({owner, ownerId, isOrg, create: canCreate, res, page}: {owner: string; ownerId: number; isOrg: boolean; create: boolean; res: Resource<RepoPage>; page: number}) {
  const {data} = useSession();
  const app = useApp();
  // An offline partial repository list must not imply the owner has none.
  const away = reach(data.status.connection) !== 'online';
  const list: RepoRow[] = res.value ? res.value.rows.map((d) => ({id: d.id, owner: d.owner.login, name: d.name, description: d.description, private: d.private, fork: d.fork, archived: d.archived, updated: d.updated_at})) :
    page > 1 ? [] : [...data.pool.model('Repository').by('owner_id', ownerId)].map((r) => {
      const d = r.data;
      return {id: d.id, owner: d.owner_name, name: d.name, description: d.description, private: d.private, fork: d.fork, archived: d.archived, updated: d.updated_at};
    }).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, PER_PAGE);
  return (
    <ResourceSection label="Repositories" title="Repositories"
      actions={canCreate && (
        <RouterLinkButton variant="invisible" size="small" leadingVisual={RepoIcon} to="/repo/create" search={isOrg ? {org: String(ownerId)} : {}}>New repository</RouterLinkButton>
      )}>
      <ResourceRows>{list.map((r) => <RepoLine key={r.id} r={r}/>)}</ResourceRows>
      {!res.value && away ?
        list.length ? <p className="px-4 py-2 text-sm text-muted">Repositories that are not on this device load when you are online.</p> :
          <EmptyState spacious={false} icon={CloudOfflineIcon} title="Not available offline" description="This owner’s repositories are not on this device. They load when you are online."/> :
        list.length ? null :
          !res.value && res.state === 'loading' ? <div className="px-4 py-3"><SkeletonText lines={3}/></div> :
            <EmptyState spacious={false} title="No repositories" description="None that you can see."/>}
      {res.value?.total !== undefined && <Pages total={res.value.total} page={page} href={(n) => tabHref(app, owner, 'repositories', isOrg, n)}/>}
    </ResourceSection>
  );
});

const SocialRepos = observer(function SocialRepos({owner, kind}: {owner: string; kind: 'stars' | 'watching'}) {
  const {data} = useSession();
  const app = useApp();
  const search = useSearch({strict: false}) as Record<string, unknown>;
  const page = pageOf(search.page);
  const path = `${kind === 'stars' ? `/users/${encodeURIComponent(owner)}/starred` : '/user/subscriptions'}?limit=${String(PER_PAGE)}&page=${String(page)}`;
  const res = useResource(`owner-${kind}:${owner}:${String(page)}`, async (signal): Promise<RepoPage> => {
    const r = await send<APIRepo[]>(app, {api: 'v1', path, signal});
    return {rows: r.value ?? [], total: r.totalCount};
  });
  const away = reach(data.status.connection) !== 'online';
  const rows = res.value?.rows;
  // Without a total, a full page implies a next one.
  const total = res.value?.total ?? (rows ? (page - 1) * PER_PAGE + rows.length + (rows.length === PER_PAGE ? 1 : 0) : 0);
  return <ResourceSection label={kind === 'stars' ? 'Stars' : 'Watching'} title={kind === 'stars' ? 'Starred repositories' : 'Watching repositories'}>
    {kind === 'stars' && <p className="px-4 py-2 text-sm text-muted">Most recently starred first.</p>}
    {rows ? <>
      <ResourceRows>{rows.map((r) => <RepoLine key={r.id} r={{...r, owner: r.owner.login, fullName: `${r.owner.login}/${r.name}`, updated: r.updated_at}}/> )}</ResourceRows>
      {!rows.length && <EmptyState spacious={false} title="No repositories"/>}
      <Pages total={total} page={page} href={(n) => tabHref(app, owner, kind, false, n)}/>
    </> : away ? <EmptyState spacious={false} title="Not available offline" description="Connect to load these repositories."/> : res.state === 'loading' ? <SkeletonText lines={3}/> : <EmptyState spacious={false} title="Could not load repositories"/>}
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
        <span>Updated <TimeAgo at={r.updated} variant="words"/></span>
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
      {!boards.length && <EmptyState spacious={false} title="No boards on this device" description="Boards appear here after they have been synced."/>}
      {boards.map((b) => {
        const href = hrefOf(app, `/-/next/projects/${String(b.id)}`);
        return <DataRow key={b.id} href={href} onClick={(e) => click(e, href)} leading={<ProjectIcon size={16} className="shrink-0"/>}>{b.get('title')}</DataRow>;
      })}
    </ResourceSection>
  );
});


