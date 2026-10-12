// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What every repository page shares: the repository the URL names (the
// route loader's id) with its group held while the page is open, the one
// repository header (owner / repository breadcrumb, the repository's tabs,
// the page's title and controls), and the page for a repository that is not
// available here.

import {RepoSocial} from './RepoSocial.tsx';
import {createLink, useLoaderData, useParams, useRouter, useRouterState} from '@tanstack/react-router';
import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect} from 'react';
import {canWrite, repoAccess, useConfirmAccess} from '../../app/access.ts';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {Missing} from '../../app/Missing.tsx';
import {ISSUE_SECTIONS} from '../../app/paths.ts';
import {classicOfHere} from '../../app/session.ts';
import {type RepoMatch, repoGone, useHold} from '../../app/repo.ts';
import {PageHeader, StackedPageHeader} from '../../app/shell/PageHeader.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {UnderlineNav} from '@primer/react';

import {ForkButton} from './ForkButton.tsx';
import {BrowserIcon, BookIcon, GraphIcon, ChevronRightIcon, IssueOpenedIcon, PlayIcon, CodeIcon, GitPullRequestIcon, ProjectIcon, GearIcon, KebabHorizontalIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {ActionMenu, ActionList} from '@primer/react';
import {RouterLink} from '../../app/routerLinks.tsx';

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

/**
 * The breadcrumb: owner (their page) / repository (its home) [› its issues or pull requests, on a detail page].
 * `heading`: the repository's name is the page's heading (its home, which has no title row).
 */
export function RepoContext({owner, repo, section, heading = false}: {owner: string; repo: string; section?: 'issues' | 'pulls' | undefined; heading?: boolean}) {
  const repoCrumb = <RouterLink to="/$owner/$repo" params={{owner, repo}} activeOptions={{exact: true}} muted className="min-w-0 truncate">{repo}</RouterLink>;
  return (
    <>
      {/* Exact: an ancestor's crumb is no "current page" (TanStack's fuzzy match marked the owner on every page). */}
      <RouterLink to="/$owner" params={{owner}} activeOptions={{exact: true}} muted className="min-w-0 truncate">{owner}</RouterLink>
      <ChevronRightIcon size={12} className="shrink-0 text-muted"/>
      {heading ? <h1 className="flex min-w-0 font-semibold">{repoCrumb}</h1> : repoCrumb}
      {section && <>
        <ChevronRightIcon size={12} className="shrink-0 text-muted"/>
        <RouterLink to={section === 'pulls' ? '/$owner/$repo/pulls' : '/$owner/$repo/issues'} params={{owner, repo}} activeOptions={{exact: true}} muted className="min-w-0 truncate">{section === 'pulls' ? 'Pull requests' : 'Issues'}</RouterLink>
      </>}
    </>
  );
}

export interface RepoHeaderProps {
  owner: string;
  repo: string;
  /** undefined: the repository is not known here (the tabs still lead to its pages). */
  repoId: number | undefined;
  /** The title row's title (on the home, which has no title row, only the tab's title when it is text). */
  title: ReactNode;
  icon?: OcticonType | undefined;
  /** The page's controls (filters, ref picker): in the title row (the home has none: its actions are in its body). */
  children?: ReactNode;
  /** The tab's title before the repository's name (default: the title when it is text). */
  docTitle?: string | undefined;
  /**
   * An issue's or a pull request's page: its list in the breadcrumb instead of the repository's tabs (a pull
   * request has tabs of its own: one row of tabs per page).
   */
  detail?: 'issues' | 'pulls' | undefined;
  /** The repository's home: the browser tab's title is the repository alone (`owner/repo`), as GitHub's. */
  home?: boolean | undefined;
}

/**
 * Every repository page's header, as GitHub's: the breadcrumb (owner / repository) and the sync indicator, the
 * repository's tabs, then the page's title and controls ("Issues", its filters and New issue; a file's path, its
 * ref picker and History). The home has no title row: the repository's name is its heading. The repository's
 * actions (Star, Watch, Fork: RepoActions) are on the home only, in its own title row (GitHub's), never in the
 * header (#252).
 *
 * A page without the repository's tabs keeps one row (breadcrumb › title, controls): an issue's or a pull
 * request's page (a pull request has tabs of its own: one row of tabs per page), and a repository that is not
 * known here (no such repository, no access: the tabs would all lead to the same dead end).
 */
export function RepoHeader({owner, repo, repoId, title, icon, children, docTitle, detail, home = false}: RepoHeaderProps) {
  const page = docTitle ?? (typeof title === 'string' ? title : undefined);
  const notFound = useRepoNotFound();
  if (repoId === undefined && notFound) {
    // No such repository: no breadcrumb into it and no page title of a section it does not have.
    return <PageHeader icon={icon} title={`${owner}/${repo}`} docTitle={`Not found · ${owner}/${repo}`}/>;
  }
  const tabTitle = page && !home ? `${page} · ${owner}/${repo}` : `${owner}/${repo}`;
  if (repoId === undefined || detail) {
    return <PageHeader icon={icon} context={<RepoContext owner={owner} repo={repo} section={detail}/>} title={title} docTitle={tabTitle} leaf={detail !== undefined}>{children}</PageHeader>;
  }
  return home ?
    <StackedPageHeader context={<RepoContext owner={owner} repo={repo} heading/>} tabs={<RepoTabs owner={owner} repo={repo} repoId={repoId}/>} docTitle={tabTitle}/> :
    <StackedPageHeader context={<RepoContext owner={owner} repo={repo}/>} tabs={<RepoTabs owner={owner} repo={repo} repoId={repoId}/>}
      icon={icon} title={title} docTitle={tabTitle}>{children}</StackedPageHeader>;
}

/** The repository's actions (Star, Watch with its menu, Fork): the home's title row only, as GitHub's. */
export function RepoActions({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  return <><RepoSocial owner={owner} repo={repo} repoId={repoId}/><ForkButton owner={owner} repo={repo} repoId={repoId}/></>;
}

type Tab = 'code' | 'issues' | 'pulls' | 'actions' | 'activity' | 'wiki' | 'settings' | undefined;

/**
 * The code views that are the Code tab, as GitHub's Code tab stays selected on a repository's files, history,
 * branches, tags and releases.
 */
const CODE_VIEWS = new Set(['src', 'blame', 'commit', 'commits', 'compare', 'branches', 'tags', 'releases']);

/** Which tab a route belongs to (site path): the repository's home is the Code tab. */
export function tabOfPath(path: string): Tab {
  const segs = path.split('/').filter(Boolean);
  if (segs[0] === '-' || segs.length < 2) return undefined;
  const kind = segs[2];
  if (kind === undefined) return 'code';
  if (kind === 'actions') return 'actions';
  if (CODE_VIEWS.has(kind)) return 'code';
  // Labels and milestones are the Issues tab's (GitHub's).
  if (ISSUE_SECTIONS.has(kind)) return 'issues';
  return kind === 'issues' || kind === 'pulls' || kind === 'activity' || kind === 'wiki' || kind === 'settings' ? kind : undefined;
}

const RepoTabLink = createLink(UnderlineNav.Item);

/**
 * Repository sections use Primer's responsive, keyboard-accessible navigation. The row (the nav and More beside it)
 * owns the divider, so it runs on under More to the panel's edge at the nav's own baseline (#287).
 */
export const RepoTabs = observer(function RepoTabs({owner, repo, repoId}: {owner: string; repo: string; repoId: number | undefined}) {
  const tab = useRouterState({select: (st) => tabOfPath(st.location.pathname)});
  const session = useSession();
  const admin = repoId !== undefined && repoAccess(session, repoId) === 'admin';
  const count = (pulls: boolean) => repoId === undefined ? 0 : openCount(session.data.pool, repoId, pulls);
  const current = (key: Tab) => tab === key ? 'page' as const : false as const;
  const shared = {params: {owner, repo}, activeProps: {}, activeOptions: {exact: true, includeSearch: false}};
  return <div className="flex min-w-0 items-center tabs-divider">
    <UnderlineNav aria-label="Repository" className="min-w-0 flex-1">
      <RepoTabLink to="/$owner/$repo" {...shared} aria-current={current('code')} icon={CodeIcon}>Code</RepoTabLink>
      <RepoTabLink to="/$owner/$repo/issues" {...shared} aria-current={current('issues')} icon={IssueOpenedIcon} counter={count(false)}>Issues</RepoTabLink>
      <RepoTabLink to="/$owner/$repo/pulls" {...shared} aria-current={current('pulls')} icon={GitPullRequestIcon} counter={count(true)}>Pull requests</RepoTabLink>
      <RepoTabLink to="/$owner/$repo/$view/$" params={{owner, repo, view: 'actions', _splat: ''}} activeProps={{}} aria-current={current('actions')} icon={PlayIcon}>Actions</RepoTabLink>
      <RepoTabLink to="/-/next/boards" search={repoId ? {repoId} : {}} activeProps={{}} icon={ProjectIcon}>Projects</RepoTabLink>
      <RepoTabLink to="/$owner/$repo/wiki" {...shared} aria-current={current('wiki')} icon={BookIcon}>Wiki</RepoTabLink>
      <RepoTabLink to="/$owner/$repo/activity" {...shared} aria-current={current('activity')} icon={GraphIcon}>Activity</RepoTabLink>
      {admin && <RepoTabLink to="/$owner/$repo/settings" {...shared} aria-current={current('settings')} icon={GearIcon}>Settings</RepoTabLink>}
    </UnderlineNav>
    <RepoMore/>
  </div>;
});

/** The open issues (or pull requests) of a repository in the pool. */
export function openCount(pool: ReturnType<typeof useSession>['data']['pool'], repoId: number, pulls: boolean): number {
  let n = 0;
  for (const e of pool.model('Issue').by('repo_id', repoId)) if (e.get('is_pull') === pulls && e.get('state') === 'open') n++;
  return n;
}

/** "More": the tabs that do not fit, and this page in the classic UI. */
function RepoMore() {
  const app = useApp();
  const here = useRouterState({select: (st) => classicOfHere(app, st.location.pathname, st.location.searchStr)});
  return (
    <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label="More of this repository">More</ActionMenu.Button><ActionMenu.Overlay><ActionList>
      <ActionList.Group><ActionList.GroupHeading>In the classic UI</ActionList.GroupHeading>
      <ClassicMenuItem to={here} icon={BrowserIcon}>This page</ClassicMenuItem>
    </ActionList.Group></ActionList></ActionMenu.Overlay></ActionMenu>
  );
}

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

