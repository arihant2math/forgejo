// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What every repository page shares: the repository the URL names (the
// route loader's id) with its group held while the page is open, the one
// repository header (owner / repository breadcrumb, the page's title and
// controls, the repository's tabs), and the page for a repository that is
// not available here.

import {Link, useLoaderData, useNavigate, useParams, useRouterState} from '@tanstack/react-router';
import {AppWindow, BookOpen, ChevronDown, KanbanSquare, MoreHorizontal, Settings, Slash, Activity} from 'lucide-react';
import {runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect} from 'react';
import {canWrite, repoAccess, useConfirmAccess} from '../../app/access.ts';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {Missing} from '../../app/Missing.tsx';
import {classicPathOf} from '../../app/paths.ts';
import {type RepoMatch, useHold} from '../../app/repo.ts';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {withEnd} from '../../code/refs.ts';
import {Button, Icon, type LucideIcon, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, TabLink, TabNav, TextLink} from '../../ui/index.ts';

export function useRepoPage(): {owner: string; repo: string; repoId: number | undefined; group: string | undefined} {
  const {owner = '', repo = ''} = useParams({strict: false});
  const loaded: unknown = useLoaderData({strict: false});
  const repoId = (loaded as RepoMatch | undefined)?.repoId;
  const {data} = useSession();
  const group = repoId === undefined ? undefined : `repo:${String(repoId)}`;
  useHold(data, group);
  // The new-issue dialog (C) creates in the repository on screen.
  const app = useApp();
  useConfirmAccess(app, owner, repo, repoId);
  useEffect(() => {
    if (repoId === undefined) return undefined;
    runInAction(() => {
      app.ui.repoOpen = repoId;
      app.ui.recentRepo = repoId;
    });
    return () => {
      runInAction(() => {
        if (app.ui.repoOpen === repoId) app.ui.repoOpen = 0;
      });
    };
  }, [app, repoId]);
  return {owner, repo, repoId, group};
}

/** Whether the viewer may edit the repository's issues (observes the pool). */
export function useCanWrite(repoId: number): boolean {
  return canWrite(useSession(), repoId);
}

/** The breadcrumb: owner (their page) / repository (its home). */
export function RepoContext({owner, repo}: {owner: string; repo: string}) {
  return (
    <>
      <TextLink><Link to="/-/next/$owner" params={{owner}}>{owner}</Link></TextLink>
      <Icon icon={Slash} size="sm" className="text-fg-subtle"/>
      <TextLink><Link to="/$owner/$repo" params={{owner, repo}} activeOptions={{exact: true}}>{repo}</Link></TextLink>
    </>
  );
}

export interface RepoHeaderProps {
  owner: string;
  repo: string;
  /** undefined: the repository is not known here (the tabs still lead to its pages). */
  repoId: number | undefined;
  title: ReactNode;
  icon?: LucideIcon | undefined;
  /** The page's controls (filters, ref picker). */
  children?: ReactNode;
  /** The tab's title before the repository's name (default: the title when it is text). */
  docTitle?: string | undefined;
}

/** Every repository page's header: breadcrumb, title and controls, then the repository's tabs. */
export function RepoHeader({owner, repo, repoId, title, icon, children, docTitle}: RepoHeaderProps) {
  const page = docTitle ?? (typeof title === 'string' ? title : undefined);
  return (
    <>
      <PageHeader icon={icon} context={<RepoContext owner={owner} repo={repo}/>} title={title} docTitle={page && page !== 'Overview' ? `${page} · ${owner}/${repo}` : `${owner}/${repo}`}>{children}</PageHeader>
      <RepoTabs owner={owner} repo={repo} repoId={repoId}/>
    </>
  );
}

type Tab = 'home' | 'issues' | 'pulls' | 'code' | 'commits' | 'branches' | 'tags' | 'releases' | 'actions' | undefined;

/** Which tab a route belongs to (site path). */
export function tabOfPath(path: string): Tab {
  const segs = path.split('/').filter(Boolean);
  if (segs[0] === '-') {
    if (segs[1] !== 'next' || segs[2] !== 'code') return undefined;
    const head = segs[5] ?? '';
    if (head === '' || head === '-' || head === 'src' || head === 'blame') return 'code';
    if (head === 'commit' || head === 'commits' || head === 'compare') return 'commits';
    if (head === 'branches' || head === 'tags' || head === 'releases' || head === 'actions') return head;
    return undefined;
  }
  const kind = segs[2];
  if (kind === undefined) return 'home';
  return kind === 'issues' || kind === 'pulls' ? kind : undefined;
}

/** The repository's sections, the same on every repository page. */
export function RepoTabs({owner, repo, repoId}: {owner: string; repo: string; repoId: number | undefined}) {
  const tab = useRouterState({select: (s) => tabOfPath(s.location.pathname)});
  const cur = (t: Tab) => ({'aria-current': tab === t ? 'page' as const : undefined, activeProps: {}, activeOptions: {exact: true, includeSearch: false}});
  const code = (to: string, t: Tab, label: string) => (
    <TabLink key={label}>
      <Link to="/-/next/code/$owner/$repo/$" params={{owner, repo, _splat: withEnd(to)}} {...cur(t)}>{label}</Link>
    </TabLink>
  );
  return (
    <TabNav label="Repository">
      <TabLink><Link to="/$owner/$repo" params={{owner, repo}} {...cur('home')}>Overview</Link></TabLink>
      <TabLink><Link to="/$owner/$repo/issues" params={{owner, repo}} {...cur('issues')}>Issues</Link></TabLink>
      <TabLink><Link to="/$owner/$repo/pulls" params={{owner, repo}} {...cur('pulls')}>Pull requests</Link></TabLink>
      {code('src', 'code', 'Code')}
      {code('commits', 'commits', 'Commits')}
      {code('branches', 'branches', 'Branches')}
      {code('tags', 'tags', 'Tags')}
      {code('releases', 'releases', 'Releases')}
      {code('actions', 'actions', 'Actions')}
      <RepoMore owner={owner} repo={repo} repoId={repoId}/>
    </TabNav>
  );
}

/** "More": the repository's boards (here) and what only the classic UI has (wiki, activity, settings). */
const RepoMore = observer(function RepoMore({owner, repo, repoId}: {owner: string; repo: string; repoId: number | undefined}) {
  const s = useSession();
  const path = useRouterState({select: (st) => st.location.pathname});
  const navigate = useNavigate();
  const boards = repoId === undefined ? [] : [...s.data.pool.model('Project').by('repo_id', repoId)].filter((p) => !p.get('closed'));
  const admin = repoId !== undefined && repoAccess(s, repoId) === 'admin';
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="More of this repository"><Icon icon={MoreHorizontal} size="sm"/>More<Icon icon={ChevronDown} size="sm"/></Button>
      </MenuTrigger>
      <MenuContent>
        {boards.length > 0 && <MenuLabel>Boards</MenuLabel>}
        {boards.map((b) => (
          <MenuItem key={b.id} icon={KanbanSquare} onSelect={() => void navigate({to: '/-/next/projects/$id', params: {id: String(b.id)}})}>{b.get('title')}</MenuItem>
        ))}
        {boards.length > 0 && <MenuSeparator/>}
        <MenuLabel>In the classic UI</MenuLabel>
        <ClassicMenuItem to={`${base}/wiki`} icon={BookOpen}>Wiki</ClassicMenuItem>
        <ClassicMenuItem to={`${base}/activity`} icon={Activity}>Activity</ClassicMenuItem>
        <ClassicMenuItem to={`${base}/projects`} icon={KanbanSquare}>Projects</ClassicMenuItem>
        {admin && <ClassicMenuItem to={`${base}/settings`} icon={Settings}>Settings</ClassicMenuItem>}
        <MenuSeparator/>
        <ClassicMenuItem to={classicPathOf(path)} icon={AppWindow}>This page</ClassicMenuItem>
      </MenuContent>
    </Menu>
  );
});

/** The page of a repository that is not known here (no such repository, no access, or offline and not synced). */
export function Unavailable({owner, repo}: {owner: string; repo: string}) {
  return <Missing what="This repository" classic={`/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`}/>;
}

