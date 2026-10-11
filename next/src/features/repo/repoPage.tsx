// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What every repository page shares: the repository the URL names (the
// route loader's id) with its group held while the page is open, the one
// repository header (owner / repository breadcrumb, the repository's tabs,
// the page's title and controls), and the page for a repository that is not
// available here.

import {Link, useLoaderData, useNavigate, useParams, useRouter, useRouterState} from '@tanstack/react-router';
import {AppWindow, BookOpen, ChartLine, ChevronDown, ChevronRight, CircleDot, CirclePlay, Code2, GitPullRequest, KanbanSquare, Settings, Slash} from 'lucide-react';
import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {Fragment, type ReactElement, type ReactNode, useEffect} from 'react';
import {canWrite, repoAccess, useConfirmAccess} from '../../app/access.ts';
import {CLASSIC_HINT, classicHref} from '../../app/classic.ts';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {Missing} from '../../app/Missing.tsx';
import {ISSUE_SECTIONS} from '../../app/paths.ts';
import {classicOfHere} from '../../app/session.ts';
import {type RepoMatch, repoGone, useHold} from '../../app/repo.ts';
import {PageHeader, StackedPageHeader} from '../../app/shell/PageHeader.tsx';
import {rememberOpened} from '../../app/create.ts';
import {useApp, useSession} from '../../app/store.ts';
import {withEnd} from '../../code/refs.ts';
import {
  Icon, type LucideIcon, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, MoreMenu, TabLink, TabNav, TextLink,
} from '../../ui/index.ts';

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
  // Renamed (or transferred) while its page is open: the address, breadcrumb and tab title follow (QA: they kept the
  // old name while the heading and the sidebar had the new one). The same page under the new name, in place.
  useEffect(() => {
    if (repoId === undefined) return undefined;
    return reaction(() => data.pool.model('Repository').get(repoId)?.get('full_name'), (full) => {
      if (!full || full.toLowerCase() === `${owner}/${repo}`.toLowerCase()) return;
      const [o = '', r = ''] = full.split('/');
      const from = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const path = location.pathname;
      const at = path.indexOf(from);
      if (at < 0 || !['/', ''].includes(path.charAt(at + from.length))) return;
      void router.navigate({href: `${path.slice(0, at)}/${encodeURIComponent(o)}/${encodeURIComponent(r)}${path.slice(at + from.length)}${location.search}${location.hash}`, replace: true});
    });
  }, [data, router, owner, repo, repoId]);
  // The new-issue dialog (C) creates in the repository on screen.
  useConfirmAccess(app, owner, repo, repoId);
  useEffect(() => {
    if (repoId === undefined) return undefined;
    runInAction(() => {
      app.ui.repoOpen = repoId;
      app.ui.recentRepo = repoId;
    });
    if (app.session) rememberOpened(app.session.userId, repoId);
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
      <Icon icon={Slash} size="sm" className="text-fg-subtle"/>
      {heading ? <h1 className="flex min-w-0 font-medium">{repoCrumb}</h1> : repoCrumb}
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
  /** The title row's title (on the home, which has no title row, only the tab's title when it is text). */
  title: ReactNode;
  icon?: LucideIcon | undefined;
  /** The page's controls (filters, ref picker): in the title row; on the home at the end of the breadcrumb's row. */
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
 * ref picker and History). The home has no title row: the repository's name is its heading, and its actions end
 * the breadcrumb's row (GitHub's repository title row).
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
    <StackedPageHeader context={<RepoContext owner={owner} repo={repo} heading/>} actions={children}
      tabs={<RepoTabs owner={owner} repo={repo} repoId={repoId}/>} docTitle={tabTitle}/> :
    <StackedPageHeader context={<RepoContext owner={owner} repo={repo}/>} tabs={<RepoTabs owner={owner} repo={repo} repoId={repoId}/>}
      icon={icon} title={title} docTitle={tabTitle}>{children}</StackedPageHeader>;
}

type Tab = 'code' | 'issues' | 'pulls' | 'actions' | 'activity' | 'wiki' | 'settings' | undefined;

/**
 * The code views that are the Code tab, as GitHub's Code tab stays selected on a repository's files, history,
 * branches, tags and releases ("" and "-": the code route's root).
 */
const CODE_VIEWS = new Set(['', '-', 'src', 'blame', 'commit', 'commits', 'compare', 'branches', 'tags', 'releases']);

/** Which tab a route belongs to (site path): the repository's home is the Code tab. */
export function tabOfPath(path: string): Tab {
  const segs = path.split('/').filter(Boolean);
  if (segs[0] === '-') {
    if (segs[1] !== 'next' || segs[2] !== 'code' || segs.length < 5) return undefined;
    const head = segs[5] ?? '';
    if (head === 'actions') return 'actions';
    return CODE_VIEWS.has(head) ? 'code' : undefined;
  }
  if (segs.length < 2) return undefined;
  const kind = segs[2];
  if (kind === undefined) return 'code';
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
  const app = useApp();
  const navigate = useNavigate();
  const cur = (t: Tab) => ({'aria-current': tab === t ? 'page' as const : undefined, activeProps: {}, activeOptions: {exact: true, includeSearch: false}});
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const boards = repoId === undefined ? [] : [...s.data.pool.model('Project').by('repo_id', repoId)].filter((p) => !p.get('closed'))
    .sort((a, b) => a.get('title').localeCompare(b.get('title')));
  const admin = repoId !== undefined && repoAccess(s, repoId) === 'admin';
  const code = {to: '/-/next/code/$owner/$repo/$', params: {owner, repo, _splat: withEnd('actions')}} as const;
  const classic = (key: string, path: string, icon: LucideIcon, label: string): RepoTab => ({
    key,
    tab: <TabLink tooltip={CLASSIC_HINT}><a href={classicHref(app, path)} data-classic=""><Icon icon={icon} size="sm"/>{label}</a></TabLink>,
    item: <ClassicMenuItem to={path} icon={icon}>{label}</ClassicMenuItem>,
  });
  const openBoard = (id: number) => {
    void navigate({to: '/-/next/projects/$id', params: {id: String(id)}});
  };
  const boardItems = boards.map((b) => <MenuItem key={b.id} icon={KanbanSquare} onSelect={() => {
    openBoard(b.id);
  }}>{b.get('title')}</MenuItem>);
  const allProjects = <ClassicMenuItem to={`${base}/projects`} icon={KanbanSquare}>All projects</ClassicMenuItem>;
  // Projects: the classic list without open boards, the board itself when there is one, a menu of them otherwise.
  const projects: RepoTab = boards.length === 0 ? classic('projects', `${base}/projects`, KanbanSquare, 'Projects') : {
    key: 'projects',
    tab: boards.length === 1 && boards[0] ?
      <TabLink><Link to="/-/next/projects/$id" params={{id: String(boards[0].id)}} activeProps={{}} activeOptions={{exact: true}}><Icon icon={KanbanSquare} size="sm"/>Projects</Link></TabLink> :
      <Menu>
        <TabLink><MenuTrigger><Icon icon={KanbanSquare} size="sm"/>Projects<Icon icon={ChevronDown} size="sm"/></MenuTrigger></TabLink>
        <MenuContent>{boardItems}<MenuSeparator/>{allProjects}</MenuContent>
      </Menu>,
    item: <><MenuLabel>Projects</MenuLabel>{boardItems}{allProjects}</>,
  };
  const tabs: RepoTab[] = [
    {
      key: 'code',
      tab: <TabLink><Link to="/$owner/$repo" params={{owner, repo}} {...cur('code')}><Icon icon={Code2} size="sm"/>Code</Link></TabLink>,
      item: <MenuItem icon={Code2} onSelect={() => void navigate({to: '/$owner/$repo', params: {owner, repo}})}>Code</MenuItem>,
    },
    {
      key: 'issues',
      tab: <TabLink><Link to="/$owner/$repo/issues" params={{owner, repo}} {...cur('issues')}><Icon icon={CircleDot} size="sm"/>Issues</Link></TabLink>,
      item: <MenuItem icon={CircleDot} onSelect={() => void navigate({to: '/$owner/$repo/issues', params: {owner, repo}})}>Issues</MenuItem>,
    },
    {
      key: 'pulls',
      tab: <TabLink><Link to="/$owner/$repo/pulls" params={{owner, repo}} {...cur('pulls')}><Icon icon={GitPullRequest} size="sm"/>Pull requests</Link></TabLink>,
      item: <MenuItem icon={GitPullRequest} onSelect={() => void navigate({to: '/$owner/$repo/pulls', params: {owner, repo}})}>Pull requests</MenuItem>,
    },
    {
      key: 'actions',
      tab: <TabLink><Link {...code} {...cur('actions')}><Icon icon={CirclePlay} size="sm"/>Actions</Link></TabLink>,
      item: <MenuItem icon={CirclePlay} onSelect={() => void navigate(code)}>Actions</MenuItem>,
    },
    projects,
    {
      key: 'wiki',
      tab: <TabLink><Link to="/$owner/$repo/wiki" params={{owner, repo}} {...cur('wiki')}><Icon icon={BookOpen} size="sm"/>Wiki</Link></TabLink>,
      item: <MenuItem icon={BookOpen} onSelect={() => void navigate({to: '/$owner/$repo/wiki', params: {owner, repo}})}>Wiki</MenuItem>,
    },
    {
      key: 'activity',
      // Every activity page (the Pulse of any period, the graphs) is this tab.
      tab: <TabLink><Link to="/$owner/$repo/activity" params={{owner, repo}} {...cur('activity')}><Icon icon={ChartLine} size="sm"/>Activity</Link></TabLink>,
      item: <MenuItem icon={ChartLine} onSelect={() => void navigate({to: '/$owner/$repo/activity', params: {owner, repo}})}>Activity</MenuItem>,
    },
    ...admin ? [{
      key: 'settings',
      tab: <TabLink><Link to="/$owner/$repo/settings" params={{owner, repo}} {...cur('settings')}><Icon icon={Settings} size="sm"/>Settings</Link></TabLink>,
      item: <MenuItem icon={Settings} onSelect={() => void navigate({to: '/$owner/$repo/settings', params: {owner, repo}})}>Settings</MenuItem>,
    }] : [],
  ];
  return (
    <TabNav label="Repository" more={(hidden) => <RepoMore overflow={tabs.filter((_, i) => hidden.includes(i))}/>}>
      {tabs.map((t) => <Fragment key={t.key}>{t.tab}</Fragment>)}
    </TabNav>
  );
});

/** "More": the tabs that do not fit, and this page in the classic UI. */
function RepoMore({overflow}: {overflow: RepoTab[]}) {
  const app = useApp();
  const here = useRouterState({select: (st) => classicOfHere(app, st.location.pathname, st.location.searchStr)});
  return (
    <MoreMenu label="More of this repository">
      {overflow.map((t) => <Fragment key={t.key}>{t.item}</Fragment>)}
      {overflow.length > 0 && <MenuSeparator/>}
      <MenuLabel>In the classic UI</MenuLabel>
      <ClassicMenuItem to={here} icon={AppWindow}>This page</ClassicMenuItem>
    </MoreMenu>
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

