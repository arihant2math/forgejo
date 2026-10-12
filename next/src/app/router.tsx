// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Site paths exclude app_sub_url; canonical routes must also be registered in the backend's spaRoutes.
// Views preload before first render and on link intent. staticData selects the next boot's skeleton.

import {untracked} from 'mobx';
import {
  createRootRouteWithContext, createRoute, createRouter, Outlet, redirect, type RouterHistory, stringifySearchWith,
} from '@tanstack/react-router';
import {isLocalPath, sitePath} from './config.ts';
import {abbreviatedCommit, codeRestOf, legacyCodeSplat, parseCodePath} from '../code/refs.ts';
import {appPageOf, codePath, nextPathOf, wikiAddress} from './paths.ts';
import {discoverySearch} from '../features/search/params.ts';
import {lazyView, whenIdle} from './lazy.tsx';
import {RouteError, RouteNotFound, ShellNotFound} from './RouteStatus.tsx';
import {loadRepo, repoFullName, type RepoMatch} from './repo.ts';
import {
  type InboxSearch, inboxSearch, type IssueListSearch, issueListSearch, type LabelsSearch, labelsSearch, type MilestonesSearch, milestonesSearch, type MyListSearch,
  myListSearch, type PageSearch, pageSearch, parsePlainSearch, type PullSearch, pullSearch,
} from './search.ts';
import {PAGE_SCROLLER} from './shell/Frame.tsx';
import {Shell} from './shell/Shell.tsx';
import {readSplash, type SkeletonHeader, type SkeletonShape} from './splash.ts';
import type {App} from './store.ts';

export interface RouterContext {
  app: App;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
  interface StaticDataRouteOption {
    skeleton?: SkeletonShape;
    /** Extra skeleton header rows; defaults to one row. */
    header?: SkeletonHeader;
  }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: RouteNotFound,
});

const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/next/callback',
  component: lazyView(() => import('../features/auth/Callback.tsx')),
});

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: Shell,
});

/** Resumes the last route unless ?to= names a classic destination.
 * Omit the trailing slash: the server rewrites exact base literals under sub-path deployments.
 */
const baseRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next',
  beforeLoad: ({context: {app}, search}) => {
    if (!app.session) return;
    const to = (search as Record<string, unknown>).to;
    const last = readSplash().route;
    const href = typeof to === 'string' ? sitePath(app.config, appPageOf(to)) :
      last && isLocalPath(app.config, last) && last !== app.config.base ? last : sitePath(app.config, '/');
    throw redirect({href, replace: true});
  },
  component: lazyView(() => import('../features/home/Home.tsx')),
});

const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/home/Home.tsx')),
});

const discoveryRoute = createRoute({getParentRoute: () => shellRoute, path: '/search', validateSearch: discoverySearch, staticData: {skeleton: 'list'}, component: lazyView(() => import('../features/search/Discovery.tsx'))});
const exploreRoute = createRoute({getParentRoute: () => shellRoute, path: '/explore', validateSearch: discoverySearch, staticData: {skeleton: 'list'}, component: lazyView(() => import('../features/search/Discovery.tsx'))});
const exploreReposRoute = createRoute({getParentRoute: () => shellRoute, path: '/explore/repos', validateSearch: discoverySearch, staticData: {skeleton: 'list'}, component: lazyView(() => import('../features/search/Discovery.tsx'))});
const exploreUsersRoute = createRoute({getParentRoute: () => shellRoute, path: '/explore/users', validateSearch: discoverySearch, staticData: {skeleton: 'list'}, component: lazyView(() => import('../features/search/Discovery.tsx'))});
const exploreOrgsRoute = createRoute({getParentRoute: () => shellRoute, path: '/explore/organizations', validateSearch: discoverySearch, staticData: {skeleton: 'list'}, component: lazyView(() => import('../features/search/Discovery.tsx'))});

const myIssuesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/issues',
  validateSearch: (s): MyListSearch => myListSearch(s),
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/my/MyWork.tsx'), 'MyIssues'),
});

const myPullsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/pulls',
  validateSearch: (s): MyListSearch => myListSearch(s),
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/my/MyWork.tsx'), 'MyPulls'),
});

const inboxRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/notifications',
  validateSearch: (s): InboxSearch => inboxSearch(s),
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/inbox/Inbox.tsx')),
});

// Reserved "repo"/"org" names and static-route precedence keep creation forms from matching repositories.
const newRepoRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/repo/create',
  validateSearch: (s): {org?: string; template_id?: string} => ({
    ...(typeof s.org === 'string' && /^[1-9]\d{0,15}$/.test(s.org) ? {org: s.org} : {}),
    ...(typeof s.template_id === 'string' && /^[1-9]\d{0,15}$/.test(s.template_id) ? {template_id: s.template_id} : {}),
  }),
  staticData: {skeleton: 'detail'},
  component: lazyView(() => import('../features/new/NewRepo.tsx'), 'NewRepo'),
});

const newOrgRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/org/create',
  staticData: {skeleton: 'detail'},
  component: lazyView(() => import('../features/new/NewOrg.tsx'), 'NewOrg'),
});

/** Resolves case-insensitive names and redirects to Forgejo's canonical spelling. */
async function repoLoader(app: App, params: {owner: string; repo: string}, location: {pathname: string; searchStr: string; hash: string}): Promise<RepoMatch> {
  const match = await loadRepo(app, params.owner, params.repo);
  const full = match.repoId === undefined ? undefined : repoFullName(app, match.repoId);
  if (full && full !== `${params.owner}/${params.repo}`) {
    const segs = location.pathname.split('/');
    const at = segs.findIndex((seg, i) => safeDecode(seg) === params.owner && safeDecode(segs[i + 1] ?? '') === params.repo);
    if (at > 0) {
      segs.splice(at, 2, ...full.split('/').map(encodeURIComponent));
      throw redirect({href: sitePath(app.config, `${segs.join('/')}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`), replace: true});
    }
  }
  return match;
}

function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}
const repoHomeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  staticData: {skeleton: 'detail', header: 'tabs'},
  component: lazyView(() => import('../features/repo/RepoHome.tsx'), 'RepoHome'),
});

const repoIssuesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/issues',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  validateSearch: (s): IssueListSearch => issueListSearch(s),
  staticData: {skeleton: 'list', header: 'toolbar'},
  component: lazyView(() => import('../features/repo/RepoViews.tsx'), 'RepoIssues'),
});

const newIssueRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/issues/new',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  validateSearch: (s): {template?: string} => typeof s.template === 'string' ? {template: s.template} : {},
  staticData: {skeleton: 'list', header: 'toolbar'},
  component: lazyView(() => import('../features/repo/RepoViews.tsx'), 'NewIssue'),
});

const repoPullsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/pulls',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  validateSearch: (s): IssueListSearch => issueListSearch(s),
  staticData: {skeleton: 'list', header: 'toolbar'},
  component: lazyView(() => import('../features/repo/RepoViews.tsx'), 'RepoPulls'),
});

const repoIssueRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/issues/$index',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  staticData: {skeleton: 'detail'},
  component: lazyView(() => import('../features/issue/IssueView.tsx'), 'IssueView'),
});

const repoPullRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/pulls/$index',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  validateSearch: (s): PullSearch => pullSearch(s),
  staticData: {skeleton: 'detail'},
  component: lazyView(() => import('../features/issue/IssueView.tsx'), 'IssueView'),
});

function settingsRoute<P extends `/$owner/$repo/settings${string}`>(path: P, view: 'SettingsGeneral' | 'SettingsCollaboration' | 'SettingsBranches' | 'SettingsHooks' | 'SettingsKeys') {
  return createRoute({
    getParentRoute: () => shellRoute,
    path,
    loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params as {owner: string; repo: string}, location),
    staticData: {skeleton: 'detail', header: 'toolbar'},
    component: lazyView(() => import('../features/settings/Settings.tsx'), view),
  });
}

const settingsRoutes = [
  settingsRoute('/$owner/$repo/settings', 'SettingsGeneral'),
  settingsRoute('/$owner/$repo/settings/collaboration', 'SettingsCollaboration'),
  settingsRoute('/$owner/$repo/settings/branches', 'SettingsBranches'),
  settingsRoute('/$owner/$repo/settings/hooks', 'SettingsHooks'),
  settingsRoute('/$owner/$repo/settings/keys', 'SettingsKeys'),
] as const;

// Wiki actions use app paths; loaders fetch on intent so hovered pages are ready on click.
function wikiAction(app: App, location: {pathname: string; searchStr: string; hash: string}): void {
  const q = new URLSearchParams(location.searchStr);
  if (!q.get('action')) return;
  const to = wikiAddress(location.pathname, location.searchStr);
  if (!to) return;
  q.delete('action');
  const rest = q.toString();
  throw redirect({href: sitePath(app.config, `${to}${rest ? `?${rest}` : ''}${location.hash ? `#${location.hash}` : ''}`), replace: true});
}

async function wikiLoader(app: App, params: {owner: string; repo: string}, location: {pathname: string; searchStr: string; hash: string}, page: string | undefined): Promise<RepoMatch> {
  const match = await repoLoader(app, params, location);
  const repoId = match.repoId;
  if (repoId !== undefined && page !== undefined) {
    void import('../features/wiki/data.ts').then((m) => {
      m.prefetchWikiPage(app, repoId, params.owner, params.repo, page);
    }, () => undefined);
  }
  return match;
}

const wikiView = (name: 'WikiHome' | 'WikiPageView' | 'WikiPages' | 'WikiNew' | 'WikiEdit') => lazyView(() => import('../features/wiki/WikiPage.tsx'), name);

const wikiHomeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/wiki',
  beforeLoad: ({context: {app}, location}) => {
    wikiAction(app, location);
  },
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => wikiLoader(app, params, location, 'Home'),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: wikiView('WikiHome'),
});

const wikiPageRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/wiki/$page',
  beforeLoad: ({context: {app}, location}) => {
    wikiAction(app, location);
  },
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => wikiLoader(app, params, location, params.page),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: wikiView('WikiPageView'),
});

const wikiPagesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/wiki/-/pages',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => wikiLoader(app, params, location, undefined),
  staticData: {skeleton: 'list', header: 'toolbar'},
  component: wikiView('WikiPages'),
});

const wikiNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/wiki/-/new',
  validateSearch: (s): {title?: string} => (typeof s.title === 'string' && s.title ? {title: s.title} : {}),
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => wikiLoader(app, params, location, undefined),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: wikiView('WikiNew'),
});

const wikiEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/wiki/$page/-/edit',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => wikiLoader(app, params, location, params.page),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: wikiView('WikiEdit'),
});

const activityView = (name: 'ActivityPulse' | 'ActivityContributors' | 'ActivityCodeFrequency' | 'ActivityRecentCommits') =>
  lazyView(() => import('../features/activity/Activity.tsx'), name);

const repoActivityRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/activity',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: activityView('ActivityPulse'),
});

const repoActivityPeriodRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/activity/$period',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: activityView('ActivityPulse'),
});

const repoContributorsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/activity/contributors',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: activityView('ActivityContributors'),
});

const repoCodeFrequencyRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/activity/code-frequency',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: activityView('ActivityCodeFrequency'),
});

const repoRecentCommitsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/activity/recent-commits',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: activityView('ActivityRecentCommits'),
});

// "user" is reserved; settings loaders prefetch on intent.
type SettingsKind = 'settings' | 'emails' | 'keys' | 'gpg' | 'options';

function settingsLoader(app: App, kinds: SettingsKind[]): void {
  void import('../features/usersettings/data.ts').then((m) => {
    m.settingsSource(app)?.prefetch(...kinds);
  }, () => undefined);
}

const settingsView = (name: 'SettingsProfile' | 'SettingsAccount' | 'SettingsAppearance' | 'SettingsKeys') =>
  lazyView(() => import('../features/usersettings/UserSettings.tsx'), name);

const settingsProfileRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/user/settings',
  loader: ({context: {app}}) => {
    settingsLoader(app, ['settings']);
  },
  staticData: {skeleton: 'detail'},
  component: settingsView('SettingsProfile'),
});

const settingsAccountRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/user/settings/account',
  loader: ({context: {app}}) => {
    settingsLoader(app, ['emails']);
  },
  staticData: {skeleton: 'detail'},
  component: settingsView('SettingsAccount'),
});

const settingsAppearanceRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/user/settings/appearance',
  loader: ({context: {app}}) => {
    settingsLoader(app, ['settings', 'options']);
  },
  staticData: {skeleton: 'detail'},
  component: settingsView('SettingsAppearance'),
});

const settingsKeysRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/user/settings/keys',
  loader: ({context: {app}}) => {
    settingsLoader(app, ['keys', 'gpg']);
  },
  staticData: {skeleton: 'detail'},
  component: settingsView('SettingsKeys'),
});

const repoLabelsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/labels',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  validateSearch: (s): LabelsSearch => labelsSearch(s),
  staticData: {skeleton: 'list', header: 'toolbar'},
  component: lazyView(() => import('../features/meta/LabelsPage.tsx'), 'LabelsPage'),
});

const repoMilestonesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/milestones',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  validateSearch: (s): MilestonesSearch => milestonesSearch(s),
  staticData: {skeleton: 'list', header: 'toolbar'},
  component: lazyView(() => import('../features/meta/MilestonesPage.tsx'), 'MilestonesPage'),
});

const repoMilestoneNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/milestones/new',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: lazyView(() => import('../features/meta/MilestoneForm.tsx'), 'NewMilestone'),
});

const repoMilestoneRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/milestone/$index',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  validateSearch: (s): IssueListSearch => issueListSearch(s),
  staticData: {skeleton: 'list', header: 'toolbar'},
  component: lazyView(() => import('../features/meta/MilestonePage.tsx'), 'MilestonePage'),
});

const repoMilestoneEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/milestone/$index/edit',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: lazyView(() => import('../features/meta/MilestoneForm.tsx'), 'EditMilestone'),
});

const repoWatchersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/watchers',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  validateSearch: (s): PageSearch => pageSearch(s),
  staticData: {skeleton: 'list', header: 'toolbar'},
  component: lazyView(() => import('../features/repo/Watchers.tsx'), 'RepoWatchers'),
});

// Board pages live below the app base because they have no canonical SPA route.
const boardsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next/boards',
  validateSearch: (s): {repoId?: number; ownerId?: number} => ({
    ...(Number.isSafeInteger(Number(s.repoId)) && Number(s.repoId) > 0 ? {repoId: Number(s.repoId)} : {}),
    ...(Number.isSafeInteger(Number(s.ownerId)) && Number(s.ownerId) > 0 ? {ownerId: Number(s.ownerId)} : {}),
  }),
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/board/BoardsList.tsx'), 'BoardsList'),
});

const boardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next/projects/$id',
  // Open an issue's board with its card as the cursor.
  validateSearch: (s): {card?: number} => (typeof s.card === 'string' && /^-?[1-9]\d{0,15}$/.test(s.card) ? {card: Number(s.card)} : {}),
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/board/BoardView.tsx'), 'BoardPage'),
});

// Catch deeper repository addresses; static routes outrank this fallback.
const codeRoute = createRoute({
  getParentRoute: () => shellRoute,
  // Require $view so an empty splat cannot outrank the repository home.
  path: '/$owner/$repo/$view/$',
  beforeLoad: ({context: {app}, params, location}) => {
    const rest = codeRestOf(params);
    if (isCodeRest(rest)) return;
    toAppPage(app, `/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/${rest}`, location);
  },
  loader: ({context: {app}, params, location}): Promise<RepoMatch> | RepoMatch =>
    (isCodeRest(codeRestOf(params)) ? repoLoader(app, params, location) : {repoId: undefined}),
  staticData: {skeleton: 'detail', header: 'toolbar'},
  component: lazyView(() => import('../features/code/CodePage.tsx'), 'CodePage'),
});

function isCodeRest(rest: string): boolean {
  return rest !== '' && (parseCodePath(rest) !== undefined || abbreviatedCommit(rest) !== undefined);
}

/** Supports bookmarked app-base code URLs, preserving query and fragment. */
const legacyCodeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next/code/$owner/$repo/$',
  beforeLoad: ({context: {app}, params, location}) => {
    const to = codePath(params.owner, params.repo, legacyCodeSplat(params._splat ?? ''));
    throw redirect({href: sitePath(app.config, `${to}${location.searchStr}${hashOf(location)}`), replace: true});
  },
  component: ShellNotFound,
});

// Profile-tab and ui=classic queries are served by the backend's classic UI.
const ownerRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner',
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/owner/OwnerPage.tsx'), 'OwnerPage'),
});

/** App-base owner URLs resolve only known owners, avoiding duplicate probes for arbitrary unknown names. */
const nextOwnerRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next/$owner',
  beforeLoad: ({context: {app}, params, search}) => {
    const login = params.owner.toLowerCase();
    const known = untracked(() => [...app.session?.data.pool.model('User').all() ?? []].some((u) => u.data.login.toLowerCase() === login));
    if (!known) return;
    const q = new URLSearchParams(search).toString();
    throw redirect({href: sitePath(app.config, `/${encodeURIComponent(params.owner)}${q ? `?${q}` : ''}`), replace: true});
  },
  component: ShellNotFound,
});

const nextRepoRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next/$owner/$repo/$',
  beforeLoad: ({context: {app}, params, location}) => {
    const rest = (params._splat ?? '').replace(/^\/+|\/+$/g, '');
    const to = nextPathOf(`/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}${rest ? `/${rest}` : ''}`);
    if (to) throw redirect({href: sitePath(app.config, `${to}${hashOf(location)}`), replace: true});
  },
  component: ShellNotFound,
});

const notFoundRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '$',
  beforeLoad: ({context: {app}, params, location}) => {
    toAppPage(app, `/${params._splat ?? ''}`, location);
  },
  component: ShellNotFound,
});

function toAppPage(app: App, raw: string, location: {searchStr: string; hash: string}): void {
  const path = `/${raw.replace(/^\/+|\/+$/g, '')}`;
  const segs = path.split('/').filter(Boolean);
  const to = segs.length > 2 ? nextPathOf(path) : undefined;
  // Preserve query parameters unless the mapped route supplies its own PR tab.
  const w = new URLSearchParams(location.searchStr).get('w');
  const query = to?.includes('?') ? (w === '1' || w === '0' ? `&w=${w}` : '') : location.searchStr;
  if (to && to !== path) throw redirect({href: sitePath(app.config, `${to}${query}${hashOf(location)}`), replace: true});
}

function hashOf(location: {hash: string}): string {
  return location.hash ? `#${location.hash}` : '';
}

const devRoutes = import.meta.env.DEV ?
  [
    createRoute({getParentRoute: () => rootRoute, path: '/-/next/dev/hydrate', component: lazyView(() => import('../dev/bench/HydrateBench.tsx'))}),
  ] :
  [];

const routeTree = rootRoute.addChildren([
  callbackRoute,
  shellRoute.addChildren([
    baseRoute, homeRoute, myIssuesRoute, myPullsRoute, inboxRoute, newRepoRoute, newOrgRoute,
    repoHomeRoute, repoIssuesRoute, newIssueRoute, repoPullsRoute, repoIssueRoute, repoPullRoute, ...settingsRoutes, boardsRoute, boardRoute, codeRoute, legacyCodeRoute,
    repoActivityRoute, repoActivityPeriodRoute, repoContributorsRoute, repoCodeFrequencyRoute, repoRecentCommitsRoute,
    wikiHomeRoute, wikiPageRoute, wikiPagesRoute, wikiNewRoute, wikiEditRoute,
    settingsProfileRoute, settingsAccountRoute, settingsAppearanceRoute, settingsKeysRoute,
    repoLabelsRoute, repoMilestonesRoute, repoMilestoneNewRoute, repoMilestoneRoute, repoMilestoneEditRoute, repoWatchersRoute,
    discoveryRoute, exploreRoute, exploreReposRoute, exploreUsersRoute, exploreOrgsRoute,
    ownerRoute, nextOwnerRoute, nextRepoRoute, notFoundRoute,
  ]),
  ...devRoutes,
]);

/** Loads common views one per idle period to keep module evaluation off interactions; heavy views load on intent. */
export function warmViews(): void {
  const views = [inboxRoute, myIssuesRoute, repoIssuesRoute, repoIssueRoute, repoHomeRoute];
  const next = () => {
    const view = views.shift()?.options.component as {preload?: () => Promise<void>} | undefined;
    if (!view?.preload) return;
    view.preload().then(() => {
      whenIdle(next);
    }, () => undefined);
  };
  whenIdle(next);
}

export function createAppRouter(app: App, history?: RouterHistory) {
  let traversal = true;
  const router = createRouter({
    routeTree,
    context: {app},
    basepath: app.config.app_sub_url || '/',
    // The base route matches with or without a trailing slash.
    trailingSlash: 'preserve',
    defaultPreload: 'intent',
    defaultPreloadDelay: 50,
    // Keep the previous page visible while local data loads.
    defaultPendingMs: 1000,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
    // Restore traversal/anchor scroll after render; reset new-page scroll before mount to avoid forced layout.
    scrollRestoration: ({location}) => traversal || location.hash !== '',
    scrollToTopSelectors: [PAGE_SCROLLER],
    // Keep classic query values as strings; route validators parse them.
    parseSearch: parsePlainSearch,
    stringifySearch: stringifySearchWith(JSON.stringify),
    ...(history ? {history} : {}),
  });
  // onBeforeLoad runs early enough to detect traversal; history subscriptions can race router boot,
  // while popstate arrives too late. Reuse the answer if loading starts twice for the same entry.
  const shown = new Set<string>();
  let first = true;
  let current: string | undefined;
  router.subscribe('onBeforeNavigate', ({toLocation}) => {
    const key = (toLocation.state as {__TSR_key?: string}).__TSR_key;
    if (key !== undefined && key === current) return;
    current = key;
    traversal = first || (key !== undefined && shown.has(key));
    first = false;
    if (key !== undefined) shown.add(key);
  });
  router.subscribe('onBeforeRouteMount', (e) => {
    const el = document.querySelector(PAGE_SCROLLER);
    if (el && !traversal && e.hrefChanged && !e.toLocation.hash) el.scrollTop = 0;
  });
  return router;
}

export type AppRouter = ReturnType<typeof createAppRouter>;

export const ROUTES = {
  repoHome: repoHomeRoute.id,
  repoIssues: repoIssuesRoute.id,
  repoPulls: repoPullsRoute.id,
  repoIssue: repoIssueRoute.id,
  repoPull: repoPullRoute.id,
  repoLabels: repoLabelsRoute.id,
  repoMilestones: repoMilestonesRoute.id,
  repoMilestone: repoMilestoneRoute.id,
  myIssues: myIssuesRoute.id,
  myPulls: myPullsRoute.id,
  code: codeRoute.id,
  repoActivityPeriod: repoActivityPeriodRoute.id,
} as const;
