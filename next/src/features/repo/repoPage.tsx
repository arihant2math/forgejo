// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later


import {repoGroup} from '../../data/models.ts';
import {RepoSocial} from './RepoSocial.tsx';
import {createLink, getRouteApi, useRouter, useRouterState} from '@tanstack/react-router';
import {reaction, runInAction} from 'mobx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect} from 'react';
import {canWrite, repoAccess, useConfirmAccess} from '../../app/access.ts';
import {ClassicMenuItem} from '../../app/ClassicMenuItem.tsx';
import {Missing} from '../../app/Missing.tsx';
import {ISSUE_SECTIONS} from '../../app/paths.ts';
import {classicOfHere} from '../../app/classic.ts';
import {repoGone, useHold} from '../../app/repo.ts';
import {PageHeader, StackedPageHeader} from '../../app/shell/PageHeader.tsx';
import {useApp, useSession} from '../../app/store.ts';
import {UnderlineNav} from '@primer/react';

import {ForkButton} from './ForkButton.tsx';
import {openCounts} from './openCounts.ts';
import {editing} from '../../intents/session.ts';
import {BrowserIcon, BookIcon, GraphIcon, IssueOpenedIcon, PlayIcon, CodeIcon, GitPullRequestIcon, ProjectIcon, GearIcon, KebabHorizontalIcon} from '@primer/octicons-react';
import type {Icon as OcticonType} from '@primer/octicons-react';
import {ActionMenu, ActionList} from '@primer/react';
import {Crumbs} from '../../components/Crumbs.tsx';

/** The layout route of every repository page; its loader resolves the repository. */
const repoRoute = getRouteApi('/shell/$owner/$repo');

export function useRepoPage(): {owner: string; repo: string; repoId: number | undefined; group: string | undefined} {
  const {owner, repo} = repoRoute.useParams();
  const repoId = repoRoute.useLoaderData({select: (m) => m.repoId});
  const {data} = useSession();
  const group = repoId === undefined ? undefined : repoGroup(repoId);
  useHold(data, group);
  // Leaving the pool alone does not prove deletion: groups outside the workspace can reload.
  // Show not-found only after Forgejo confirms absence with 404.
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

export function useCanWrite(repoId: number): boolean {
  return canWrite(useSession(), repoId);
}

/** owner / repository [/ Issues | Pull requests] */
function RepoContext({owner, repo, section}: {owner: string; repo: string; section?: 'issues' | 'pulls' | undefined}) {
  return <Crumbs crumbs={[
    {label: owner, link: {to: '/$owner', params: {owner}}},
    {label: repo, link: {to: '/$owner/$repo', params: {owner, repo}}},
    ...(section ? [{label: section === 'pulls' ? 'Pull requests' : 'Issues', link: {to: section === 'pulls' ? '/$owner/$repo/pulls' : '/$owner/$repo/issues', params: {owner, repo}}} as const] : []),
  ]}/>;
}

export interface RepoHeaderProps {
  owner: string;
  repo: string;
  /** Undefined when the repository is unknown locally. */
  repoId: number | undefined;
  /** On the home page, used only for the browser tab title when it is text. */
  title: ReactNode;
  icon?: OcticonType | undefined;
  children?: ReactNode;
  /** Defaults to the title when it is text. */
  docTitle?: string | undefined;
  /** Detail pages replace repository tabs with a list breadcrumb to avoid two tab rows. */
  detail?: 'issues' | 'pulls' | undefined;
  home?: boolean | undefined;
  /** The page's h1 text when the title is a nav rather than heading content (see StackedPageHeader). */
  heading?: string | undefined;
}

/** Unknown repositories omit tabs; detail pages keep a single breadcrumb row alongside their own tabs. */
export function RepoHeader({owner, repo, repoId, title, icon, children, docTitle, detail, home = false, heading}: RepoHeaderProps) {
  const page = docTitle ?? (typeof title === 'string' ? title : undefined);
  const notFound = useRepoNotFound();
  if (repoId === undefined && notFound) {
    // An unknown repository must not link back into itself.
    return <PageHeader icon={icon} title={`${owner}/${repo}`} docTitle={`Not found · ${owner}/${repo}`}/>;
  }
  const tabTitle = page && !home ? `${page} · ${owner}/${repo}` : `${owner}/${repo}`;
  if (repoId === undefined || detail) {
    return <PageHeader icon={icon} context={<RepoContext owner={owner} repo={repo} section={detail}/>} title={title} docTitle={tabTitle} leaf={detail !== undefined}>{children}</PageHeader>;
  }
  return home ?
    <StackedPageHeader context={<RepoContext owner={owner} repo={repo}/>} tabs={<RepoTabs owner={owner} repo={repo} repoId={repoId}/>} docTitle={tabTitle}/> :
    <StackedPageHeader context={<RepoContext owner={owner} repo={repo}/>} tabs={<RepoTabs owner={owner} repo={repo} repoId={repoId}/>}
      icon={icon} title={title} docTitle={tabTitle} heading={heading}>{children}</StackedPageHeader>;
}

export function RepoActions({owner, repo, repoId}: {owner: string; repo: string; repoId: number}) {
  return <RepoSocial owner={owner} repo={repo} repoId={repoId}><ForkButton owner={owner} repo={repo} repoId={repoId}/></RepoSocial>;
}

type Tab = 'code' | 'issues' | 'pulls' | 'actions' | 'activity' | 'wiki' | 'settings' | undefined;

const CODE_VIEWS = new Set(['src', 'blame', 'commit', 'commits', 'compare', 'branches', 'tags', 'releases']);

export function tabOfPath(path: string): Tab {
  const segs = path.split('/').filter(Boolean);
  if (segs[0] === '-' || segs.length < 2) return undefined;
  const kind = segs[2];
  if (kind === undefined) return 'code';
  if (kind === 'actions') return 'actions';
  if (CODE_VIEWS.has(kind)) return 'code';
  if (ISSUE_SECTIONS.has(kind)) return 'issues';
  return kind === 'issues' || kind === 'pulls' || kind === 'activity' || kind === 'wiki' || kind === 'settings' ? kind : undefined;
}

const RepoTabLink = createLink(UnderlineNav.Item);

/** The nav row owns the divider so it extends beneath More at the nav's baseline. */
export const RepoTabs = observer(function RepoTabs({owner, repo, repoId}: {owner: string; repo: string; repoId: number | undefined}) {
  const tab = useRouterState({select: (st) => tabOfPath(st.location.pathname)});
  const session = useSession();
  const admin = repoId !== undefined && repoAccess(session, repoId) === 'admin';
  const app = useApp();
  const counts = repoId === undefined ? undefined : openCounts(session.data.pool, editing(app).overlay, repoId).get();
  const current = (key: Tab) => tab === key ? 'page' as const : false as const;
  const shared = {params: {owner, repo}, activeProps: {}, activeOptions: {exact: true, includeSearch: false}};
  return <div className="flex min-w-0 items-center tabs-divider">
    <UnderlineNav aria-label="Repository" className="min-w-0 flex-1">
      <RepoTabLink to="/$owner/$repo" {...shared} aria-current={current('code')} icon={CodeIcon}>Code</RepoTabLink>
      <RepoTabLink to="/$owner/$repo/issues" {...shared} aria-current={current('issues')} icon={IssueOpenedIcon} counter={counts?.issues ?? 0}>Issues</RepoTabLink>
      <RepoTabLink to="/$owner/$repo/pulls" {...shared} aria-current={current('pulls')} icon={GitPullRequestIcon} counter={counts?.pulls ?? 0}>Pull requests</RepoTabLink>
      <RepoTabLink to="/$owner/$repo/$view/$" params={{owner, repo, view: 'actions', _splat: ''}} activeProps={{}} aria-current={current('actions')} icon={PlayIcon}>Actions</RepoTabLink>
      <RepoTabLink to="/-/next/boards" search={repoId ? {repoId} : {}} activeProps={{}} icon={ProjectIcon}>Projects</RepoTabLink>
      <RepoTabLink to="/$owner/$repo/wiki" {...shared} aria-current={current('wiki')} icon={BookIcon}>Wiki</RepoTabLink>
      <RepoTabLink to="/$owner/$repo/activity" {...shared} aria-current={current('activity')} icon={GraphIcon}>Activity</RepoTabLink>
      {admin && <RepoTabLink to="/$owner/$repo/settings" {...shared} aria-current={current('settings')} icon={GearIcon}>Settings</RepoTabLink>}
    </UnderlineNav>
    <RepoMore/>
  </div>;
});

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

function useRepoNotFound(): boolean {
  return repoRoute.useLoaderData({select: (m) => m.notFound === true});
}

/** Offer Home, not a classic link, when Forgejo confirms the repository is absent. */
export function Unavailable({owner, repo}: {owner: string; repo: string}) {
  const notFound = useRepoNotFound();
  return <Missing what="This repository" classic={notFound ? undefined : `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`}/>;
}

