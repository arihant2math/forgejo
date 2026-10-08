// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The route tree (TanStack Router). Routes are Forgejo's canonical URLs
// (B8 `spaRoutes`, routers/livesync/spa.go: the server sends index.html for
// them to browsers that opted in), plus the UI's own pages below its base.
// The router's basepath is the instance's sub-path (`app_sub_url`), so
// paths here are site paths without it: "/-/next/callback" is below the
// base wherever Forgejo is mounted, and links never build "/-/next" URLs by
// hand. routes.test.ts checks this table against spaRoutes.
//
// Every view is its own chunk (lazyView). main.tsx awaits
// router.load() before the first render, which loads the current route's
// chunk: the boot route never renders through Suspense (F1). Links preload
// their route on intent (hover, focus).
//
// Adding a route: a `createRoute` below (component lazy, `staticData.skeleton`
// for the splash), its view in src/features/<area>/, and — for a canonical
// URL — the same pattern in spaRoutes (backend) so a reload serves the UI.

import {
  createRootRouteWithContext, createRoute, createRouter, Outlet, redirect, type RouterHistory,
} from '@tanstack/react-router';
import {isLocalPath, sitePath} from './config.ts';
import {lazyView} from './lazy.tsx';
import {RouteError, RouteNotFound} from './RouteStatus.tsx';
import {loadRepo, type RepoMatch} from './repo.ts';
import {type InboxSearch, inboxSearch, type IssueListSearch, issueListSearch, type MyListSearch, myListSearch, type PullSearch, pullSearch} from './search.ts';
import {Shell} from './shell/Shell.tsx';
import {readSplash, type SkeletonShape} from './splash.ts';
import type {App} from './store.ts';

export interface RouterContext {
  app: App;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
  interface StaticDataRouteOption {
    /** The skeleton the boot shell shows when the app reloads on this route (splash). */
    skeleton?: SkeletonShape;
  }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: RouteNotFound,
});

// The UI's own pages (below the base, outside the shell).
const callbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/-/next/callback',
  component: lazyView(() => import('../features/auth/Callback.tsx')),
});

// Signed in: the app shell; otherwise the logged-out screen.
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: Shell,
});

/**
 * The base URL resumes the last route (splash), or the dashboard. Written
 * without the trailing slash (it matches "/-/next/" too): B8 rewrites every
 * string literal that is exactly the base under a sub-path, which would turn
 * a router path into a site path.
 */
const baseRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next',
  beforeLoad: ({context: {app}}) => {
    if (!app.session) return;
    const last = readSplash().route;
    const href = last && isLocalPath(app.config, last) && last !== app.config.base ? last : sitePath(app.config, '/');
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack's redirect protocol
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

// Repository routes resolve the repository (pool, else API v1) and hydrate
// its group. `$index` stays a string in the URL; views parse it.
const repoIssuesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/issues',
  loader: ({context: {app}, params}): Promise<RepoMatch> => loadRepo(app, params.owner, params.repo),
  validateSearch: (s): IssueListSearch => issueListSearch(s),
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/repo/RepoViews.tsx'), 'RepoIssues'),
});

const repoPullsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/pulls',
  loader: ({context: {app}, params}): Promise<RepoMatch> => loadRepo(app, params.owner, params.repo),
  validateSearch: (s): IssueListSearch => issueListSearch(s),
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/repo/RepoViews.tsx'), 'RepoPulls'),
});

const repoIssueRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/issues/$index',
  loader: ({context: {app}, params}): Promise<RepoMatch> => loadRepo(app, params.owner, params.repo),
  staticData: {skeleton: 'detail'},
  component: lazyView(() => import('../features/issue/IssueView.tsx'), 'IssueView'),
});

const repoPullRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/pulls/$index',
  loader: ({context: {app}, params}): Promise<RepoMatch> => loadRepo(app, params.owner, params.repo),
  validateSearch: (s): PullSearch => pullSearch(s),
  staticData: {skeleton: 'detail'},
  component: lazyView(() => import('../features/issue/IssueView.tsx'), 'IssueView'),
});

// The UI's own pages inside the shell (no canonical Forgejo URL serves them yet: B8's spaRoutes would need
// `/{owner}/{repo}/projects/{id}` etc., a backend change; below the base they reload into the app anyway).
const boardsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next/boards',
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/board/BoardsList.tsx'), 'BoardsList'),
});

const boardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next/projects/$id',
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/board/BoardView.tsx'), 'BoardPage'),
});

// Code (F7): one route for every code view of a repository; the path after it mirrors Forgejo's
// (`src/branch/main/…`, `commit/<sha>`, `compare/a...b`, …), parsed by the view (code/refs.ts).
const codeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next/code/$owner/$repo/$',
  loader: ({context: {app}, params}): Promise<RepoMatch> => loadRepo(app, params.owner, params.repo),
  staticData: {skeleton: 'detail'},
  component: lazyView(() => import('../features/code/CodePage.tsx'), 'CodePage'),
});

// Dev-only pages: `import.meta.env.DEV` is false in production builds, so
// they and their chunks are not shipped.
const devRoutes = import.meta.env.DEV ?
  [
    createRoute({getParentRoute: () => rootRoute, path: '/-/next/gallery', component: lazyView(() => import('../dev/gallery/Gallery.tsx'))}),
    createRoute({getParentRoute: () => rootRoute, path: '/-/next/dev/hydrate', component: lazyView(() => import('../dev/bench/HydrateBench.tsx'))}),
  ] :
  [];

const routeTree = rootRoute.addChildren([
  callbackRoute,
  shellRoute.addChildren([
    baseRoute, homeRoute, myIssuesRoute, myPullsRoute, inboxRoute,
    repoIssuesRoute, repoPullsRoute, repoIssueRoute, repoPullRoute, boardsRoute, boardRoute, codeRoute,
  ]),
  ...devRoutes,
]);

export function createAppRouter(app: App, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: {app},
    basepath: app.config.app_sub_url || '/',
    // The base is a page of its own; never rewrite slashes.
    trailingSlash: 'preserve',
    defaultPreload: 'intent',
    defaultPreloadDelay: 50,
    // Loaders read IndexedDB (or the API for a repository outside the pool):
    // show the previous page meanwhile, never a spinner for local data.
    defaultPendingMs: 1000,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
    ...(history ? {history} : {}),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

/** Route ids, for views that read their own params (`useParams({from})`). */
export const ROUTES = {
  repoIssues: repoIssuesRoute.id,
  repoPulls: repoPullsRoute.id,
  repoIssue: repoIssueRoute.id,
  repoPull: repoPullRoute.id,
  myIssues: myIssuesRoute.id,
  myPulls: myPullsRoute.id,
  code: codeRoute.id,
} as const;
