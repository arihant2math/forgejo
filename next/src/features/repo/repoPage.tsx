// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What every repository page shares: the repository the URL names (the
// route loader's id) with its group held while the page is open, the one
// repository header (owner / repository breadcrumb, the repository's tabs,
// the page's title and controls), and the page for a repository that is not
// available here.

import {RepoSocial} from './RepoSocial.tsx';
import {Link, useLoaderData, useNavigate, useParams, useRouter, useRouterState} from '@tanstack/react-router';
import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {Fragment, type ReactElement, type ReactNode, useEffect} from 'react';
import {canWrite, repoAccess, useConfirmAccess} from '../../app/access.ts';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {Missing} from '../../app/Missing.tsx';
import {ISSUE_SECTIONS} from '../../app/paths.ts';
import {classicOfHere} from '../../app/session.ts';
import {type RepoMatch, repoGone, useHold} from '../../app/repo.ts';
import {PageHeader, StackedPageHeader} from '../../app/shell/PageHeader.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {
  Badge, TabLink, TabNav, TextLink,
} from '../../ui/index.ts';

import {ForkButton} from './ForkButton.tsx';
import {BrowserIcon, BookIcon, GraphIcon, ChevronRightIcon, IssueOpenedIcon, PlayIcon, CodeIcon, GitPullRequestIcon, ProjectIcon, GearIcon, KebabHorizontalIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {ActionMenu, ActionList} from '@primer/react';

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
  const repoCrumb = <TextLink><Link to="/$owner/$repo" params={{owner, repo}} activeOptions={{exact: true}}>{repo}</Link></TextLink>;
  return (
    <>
      {/* Exact: an ancestor's crumb is no "current page" (TanStack's fuzzy match marked the owner on every page). */}
      <TextLink><Link to="/$owner" params={{owner}} activeOptions={{exact: true}}>{owner}</Link></TextLink>
      <ChevronRightIcon size={12} className="shrink-0 text-fg-subtle"/>
      {heading ? <h1 className="flex min-w-0 font-medium">{repoCrumb}</h1> : repoCrumb}
      {section && <>
        <ChevronRightIcon size={12} className="shrink-0 text-fg-subtle"/>
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
    return <PageHeader icon={icon} context={<RepoContext owner={owner} repo={repo} section={detail}/>} title={title} docTitle={tabTitle}>{children}</PageHeader>;
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

/** One of the repository's tabs: in the bar, and the same entry as a row of "More" when the bar is too narrow. */
interface RepoTab {
  key: string;
  tab: ReactElement;
  item: ReactNode;
}

/**
 * The repository's sections, the same on every repository page, in GitHub's order: Code (the home and every code
 * view), Issues, Pull requests, Actions, Projects (its boards), Wiki, Activity (GitHub's Insights) and, for
 * admins, Settings. Pages only the classic UI has open it (marked, hinted); each is one entry to repoint when it
 * is ported. What does not fit goes into "More", with the classic version of the page on screen.
 */
export const RepoTabs = observer(function RepoTabs({owner, repo, repoId}: {owner: string; repo: string; repoId: number | undefined}) {
  const tab = useRouterState({select: (st) => tabOfPath(st.location.pathname)});
  const s = useSession();
  const navigate = useNavigate();
  const cur = (t: Tab) => ({'aria-current': tab === t ? 'page' as const : undefined, activeProps: {}, activeOptions: {exact: true, includeSearch: false}});
  const admin = repoId !== undefined && repoAccess(s, repoId) === 'admin';
  const code = {to: '/$owner/$repo/$view/$', params: {owner, repo, view: 'actions', _splat: ''}} as const;
  const projects: RepoTab = {
    key: 'projects',
    tab: <RepoTabLink><Link to="/-/next/boards" search={repoId ? {repoId} : {}} activeProps={{}}><ProjectIcon size={12} className="shrink-0"/>Projects</Link></RepoTabLink>,
    item: <ActionList.Item onSelect={() => void navigate({to: '/-/next/boards', search: repoId ? {repoId} : {}})}><ActionList.LeadingVisual><ProjectIcon/></ActionList.LeadingVisual>Projects</ActionList.Item>,
  };
  const tabs: RepoTab[] = [
    {
      key: 'code',
      tab: <RepoTabLink><Link to="/$owner/$repo" params={{owner, repo}} {...cur('code')}><CodeIcon size={12} className="shrink-0"/>Code</Link></RepoTabLink>,
      item: <ActionList.Item onSelect={() => void navigate({to: '/$owner/$repo', params: {owner, repo}})}><ActionList.LeadingVisual><CodeIcon/></ActionList.LeadingVisual>Code</ActionList.Item>,
    },
    {
      key: 'issues',
      tab: <RepoTabLink><Link to="/$owner/$repo/issues" params={{owner, repo}} {...cur('issues')}><IssueOpenedIcon size={12} className="shrink-0"/>Issues<OpenCount repoId={repoId} pulls={false}/></Link></RepoTabLink>,
      item: <ActionList.Item onSelect={() => void navigate({to: '/$owner/$repo/issues', params: {owner, repo}})}><ActionList.LeadingVisual><IssueOpenedIcon/></ActionList.LeadingVisual>Issues</ActionList.Item>,
    },
    {
      key: 'pulls',
      tab: <RepoTabLink><Link to="/$owner/$repo/pulls" params={{owner, repo}} {...cur('pulls')}><GitPullRequestIcon size={12} className="shrink-0"/>Pull requests<OpenCount repoId={repoId} pulls/></Link></RepoTabLink>,
      item: <ActionList.Item onSelect={() => void navigate({to: '/$owner/$repo/pulls', params: {owner, repo}})}><ActionList.LeadingVisual><GitPullRequestIcon/></ActionList.LeadingVisual>Pull requests</ActionList.Item>,
    },
    {
      key: 'actions',
      tab: <RepoTabLink><Link {...code} {...cur('actions')}><PlayIcon size={12} className="shrink-0"/>Actions</Link></RepoTabLink>,
      item: <ActionList.Item onSelect={() => void navigate(code)}><ActionList.LeadingVisual><PlayIcon/></ActionList.LeadingVisual>Actions</ActionList.Item>,
    },
    projects,
    {
      key: 'wiki',
      tab: <RepoTabLink><Link to="/$owner/$repo/wiki" params={{owner, repo}} {...cur('wiki')}><BookIcon size={12} className="shrink-0"/>Wiki</Link></RepoTabLink>,
      item: <ActionList.Item onSelect={() => void navigate({to: '/$owner/$repo/wiki', params: {owner, repo}})}><ActionList.LeadingVisual><BookIcon/></ActionList.LeadingVisual>Wiki</ActionList.Item>,
    },
    {
      key: 'activity',
      // Every activity page (the Pulse of any period, the graphs) is this tab.
      tab: <RepoTabLink><Link to="/$owner/$repo/activity" params={{owner, repo}} {...cur('activity')}><GraphIcon size={12} className="shrink-0"/>Activity</Link></RepoTabLink>,
      item: <ActionList.Item onSelect={() => void navigate({to: '/$owner/$repo/activity', params: {owner, repo}})}><ActionList.LeadingVisual><GraphIcon/></ActionList.LeadingVisual>Activity</ActionList.Item>,
    },
    ...admin ? [{
      key: 'settings',
      tab: <RepoTabLink><Link to="/$owner/$repo/settings" params={{owner, repo}} {...cur('settings')}><GearIcon size={12} className="shrink-0"/>Settings</Link></RepoTabLink>,
      item: <ActionList.Item onSelect={() => void navigate({to: '/$owner/$repo/settings', params: {owner, repo}})}><ActionList.LeadingVisual><GearIcon/></ActionList.LeadingVisual>Settings</ActionList.Item>,
    }] : [],
  ];
  return (
    <TabNav label="Repository" more={(hidden) => <RepoMore overflow={tabs.filter((_, i) => hidden.includes(i))}/>}>
      {tabs.map((t) => <Fragment key={t.key}>{t.tab}</Fragment>)}
    </TabNav>
  );
});

/** One of the repository's tabs, as GitHub's: the current one is underlined on the bar's bottom edge (not filled). */
function RepoTabLink({children}: {children: ReactElement}) {
  return <TabLink current="underline">{children}</TabLink>;
}

/**
 * How many issues (or pull requests) of the repository are open, after its tab's name as GitHub's; none when there
 * are none. From the pool (the repository's open issues are synced): no request.
 */
const OpenCount = observer(function OpenCount({repoId, pulls}: {repoId: number | undefined; pulls: boolean}) {
  const {data} = useSession();
  if (repoId === undefined) return null;
  const n = openCount(data.pool, repoId, pulls);
  return n > 0 ? <Badge round>{n.toLocaleString()}</Badge> : null;
});

/** The open issues (or pull requests) of a repository in the pool. */
export function openCount(pool: ReturnType<typeof useSession>['data']['pool'], repoId: number, pulls: boolean): number {
  let n = 0;
  for (const e of pool.model('Issue').by('repo_id', repoId)) if (e.get('is_pull') === pulls && e.get('state') === 'open') n++;
  return n;
}

/** "More": the tabs that do not fit, and this page in the classic UI. */
function RepoMore({overflow}: {overflow: RepoTab[]}) {
  const app = useApp();
  const here = useRouterState({select: (st) => classicOfHere(app, st.location.pathname, st.location.searchStr)});
  return (
    <ActionMenu><ActionMenu.Button variant="invisible" size="small" leadingVisual={KebabHorizontalIcon} aria-label="More of this repository">More</ActionMenu.Button><ActionMenu.Overlay><ActionList>
      {overflow.map((t) => <Fragment key={t.key}>{t.item}</Fragment>)}
      {overflow.length > 0 && <ActionList.Divider/>}
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

