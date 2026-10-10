// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What every repository page shares: the repository the URL names (the
// route loader's id) with its group held while the page is open, the one
// repository header (owner / repository breadcrumb, the page's title and
// controls, the repository's tabs), and the page for a repository that is
// not available here.

import {Link, useLoaderData, useNavigate, useParams, useRouter, useRouterState} from '@tanstack/react-router';
import {AppWindow, BookOpen, ChevronRight, KanbanSquare, Settings, Slash, Activity} from 'lucide-react';
import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect} from 'react';
import {canWrite, repoAccess, useConfirmAccess} from '../../app/access.ts';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {Missing} from '../../app/Missing.tsx';
import {classicOfHere} from '../../app/session.ts';
import {type RepoMatch, repoGone, useHold} from '../../app/repo.ts';
import {PageHeader} from '../../app/shell/PageHeader.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {withEnd} from '../../code/refs.ts';
import {Icon, type LucideIcon, MenuItem, MenuLabel, MenuSeparator, MoreMenu, TabLink, TabNav, TextLink} from '../../ui/index.ts';

export function useRepoPage(): {owner: string; repo: string; repoId: number | undefined; group: string | undefined} {
  const {owner = '', repo = ''} = useParams({strict: false});
  const loaded: unknown = useLoaderData({strict: false});
  const repoId = (loaded as RepoMatch | undefined)?.repoId;
  const {data} = useSession();
  const group = repoId === undefined ? undefined : `repo:${String(repoId)}`;
  useHold(data, group);
  // A repository deleted (or made invisible) while its page is open: once it leaves the pool and Forgejo confirms
  // it is gone (404), the route asks again and the page becomes the not-found state (not an empty repository with
  // its tabs and New issue). Leaving the pool alone proves nothing: a group outside the workspace is dropped and
  // loaded again (the e2e triage flow went "Not found" on its first label change).
  const router = useRouter();
  const app = useApp();
  useEffect(() => {
    if (repoId === undefined) return undefined;
    let live = true;
    const off = reaction(() => data.pool.model('Repository').get(repoId) !== undefined, (has, had) => {
      if (!had || has) return;
      void repoGone(app, owner, repo).then((gone) => {
        if (gone && live) void router.invalidate();
      });
    });
    return () => {
      live = false;
      off();
    };
  }, [app, data, router, owner, repo, repoId]);
  // The new-issue dialog (C) creates in the repository on screen.
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

/** The breadcrumb: owner (their page) / repository (its home) [› its issues or pull requests, on a detail page]. */
export function RepoContext({owner, repo, section}: {owner: string; repo: string; section?: 'issues' | 'pulls' | undefined}) {
  return (
    <>
      {/* Exact: an ancestor's crumb is no "current page" (TanStack's fuzzy match marked the owner on every page). */}
      <TextLink><Link to="/$owner" params={{owner}} activeOptions={{exact: true}}>{owner}</Link></TextLink>
      <Icon icon={Slash} size="sm" className="text-fg-subtle"/>
      <TextLink><Link to="/$owner/$repo" params={{owner, repo}} activeOptions={{exact: true}}>{repo}</Link></TextLink>
      {section && <>
        <Icon icon={ChevronRight} size="sm" className="text-fg-subtle"/>
        <TextLink>
          <Link to={section === 'pulls' ? '/$owner/$repo/pulls' : '/$owner/$repo/issues'} params={{owner, repo}} activeOptions={{exact: true}}>
            {section === 'pulls' ? 'Pull requests' : 'Issues'}
          </Link>
        </TextLink>
      </>}
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
  /**
   * An issue's or a pull request's page: its list in the breadcrumb instead of the repository's tabs (a pull
   * request has tabs of its own: one row of tabs per page).
   */
  detail?: 'issues' | 'pulls' | undefined;
}

/**
 * Every repository page's header: breadcrumb, title and controls, then the repository's tabs — none for a
 * repository that is not known here (no such repository, no access): they would all lead to the same dead end.
 */
export function RepoHeader({owner, repo, repoId, title, icon, children, docTitle, detail}: RepoHeaderProps) {
  const page = docTitle ?? (typeof title === 'string' ? title : undefined);
  const notFound = useRepoNotFound();
  if (repoId === undefined && notFound) {
    // No such repository: no breadcrumb into it and no page title of a section it does not have.
    return <PageHeader icon={icon} title={`${owner}/${repo}`} docTitle={`Not found · ${owner}/${repo}`}/>;
  }
  return (
    <>
      <PageHeader icon={icon} context={<RepoContext owner={owner} repo={repo} section={detail}/>} title={title}
        docTitle={page && page !== 'Overview' ? `${page} · ${owner}/${repo}` : `${owner}/${repo}`}>{children}</PageHeader>
      {repoId !== undefined && !detail && <RepoTabs owner={owner} repo={repo} repoId={repoId}/>}
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
  const app = useApp();
  const here = useRouterState({select: (st) => classicOfHere(app, st.location.pathname, st.location.searchStr)});
  const navigate = useNavigate();
  const boards = repoId === undefined ? [] : [...s.data.pool.model('Project').by('repo_id', repoId)].filter((p) => !p.get('closed'));
  const admin = repoId !== undefined && repoAccess(s, repoId) === 'admin';
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return (
    <MoreMenu label="More of this repository">
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
        <ClassicMenuItem to={here} icon={AppWindow}>This page</ClassicMenuItem>
    </MoreMenu>
  );
});

/** Whether the route's loader learnt from Forgejo that the repository does not exist (or is not visible). */
function useRepoNotFound(): boolean {
  const loaded: unknown = useLoaderData({strict: false});
  return (loaded as RepoMatch | undefined)?.notFound === true;
}

/**
 * The page of a repository that is not known here (no such repository, no access, or offline and not synced).
 * When Forgejo answered that it does not exist, the classic UI has no page for it either: Home is the way on.
 */
export function Unavailable({owner, repo}: {owner: string; repo: string}) {
  const notFound = useRepoNotFound();
  return <Missing what="This repository" classic={notFound ? undefined : `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`}/>;
}

