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

import {untracked} from 'mobx';
import {
  createRootRouteWithContext, createRoute, createRouter, Outlet, redirect, type RouterHistory, stringifySearchWith,
} from '@tanstack/react-router';
import {isLocalPath, sitePath} from './config.ts';
import {appPageOf, nextPathOf} from './paths.ts';
import {lazyView, whenIdle} from './lazy.tsx';
import {RouteError, RouteNotFound, ShellNotFound} from './RouteStatus.tsx';
import {loadRepo, repoFullName, type RepoMatch} from './repo.ts';
import {
  type InboxSearch, inboxSearch, type IssueListSearch, issueListSearch, type MyListSearch, myListSearch, parsePlainSearch, type PullSearch, pullSearch,
} from './search.ts';
import {PAGE_SCROLLER} from './shell/Frame.tsx';
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
 * The base URL resumes the last route (splash), or the dashboard. `?to=` names a classic address (the classic
 * pages' "Back to Forgejo Next"): the app's page for it (nextPathOf), else Home — never an unrelated page resumed.
 * Written without the trailing slash (it matches "/-/next/" too): B8 rewrites every string literal that is
 * exactly the base under a sub-path, which would turn a router path into a site path.
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

/**
 * The loader of a repository route. Names are case-insensitive, so `/ACME/Atlas` finds acme/atlas: the address is
 * then rewritten to the repository's own spelling (the URL, breadcrumb and tab title are the canonical ones).
 */
async function repoLoader(app: App, params: {owner: string; repo: string}, location: {pathname: string; searchStr: string; hash: string}): Promise<RepoMatch> {
  const match = await loadRepo(app, params.owner, params.repo);
  const full = match.repoId === undefined ? undefined : repoFullName(app, match.repoId);
  if (full && full !== `${params.owner}/${params.repo}`) {
    const segs = location.pathname.split('/');
    const at = segs.findIndex((seg, i) => safeDecode(seg) === params.owner && safeDecode(segs[i + 1] ?? '') === params.repo);
    if (at > 0) {
      segs.splice(at, 2, ...full.split('/').map(encodeURIComponent));
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack's redirect protocol
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
  staticData: {skeleton: 'detail'},
  component: lazyView(() => import('../features/repo/RepoHome.tsx'), 'RepoHome'),
});

const repoIssuesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/issues',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  validateSearch: (s): IssueListSearch => issueListSearch(s),
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/repo/RepoViews.tsx'), 'RepoIssues'),
});

const repoPullsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner/$repo/pulls',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  validateSearch: (s): IssueListSearch => issueListSearch(s),
  staticData: {skeleton: 'list'},
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
  // `card`: the issue whose card gets the cursor (an issue's Project link opens its board on its card).
  validateSearch: (s): {card?: number} => (typeof s.card === 'string' && /^-?[1-9]\d{0,15}$/.test(s.card) ? {card: Number(s.card)} : {}),
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/board/BoardView.tsx'), 'BoardPage'),
});

// Code (F7): one route for every code view of a repository; the path after it mirrors Forgejo's
// (`src/branch/main/…`, `commit/<sha>`, `compare/a...b`, …), parsed by the view (code/refs.ts).
const codeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next/code/$owner/$repo/$',
  loader: ({context: {app}, params, location}): Promise<RepoMatch> => repoLoader(app, params, location),
  staticData: {skeleton: 'detail'},
  component: lazyView(() => import('../features/code/CodePage.tsx'), 'CodePage'),
});

// An owner (user or organization): its repositories here, its profile in the classic UI (`/{owner}?tab=…` and
// `?ui=classic` are served the classic page: spa.go). A name Forgejo reserves (`/explore`) is no owner (the
// page says not found).
const ownerRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/$owner',
  staticData: {skeleton: 'list'},
  component: lazyView(() => import('../features/owner/OwnerPage.tsx'), 'OwnerPage'),
});

/**
 * The owner page's former address below the base — for an owner this device knows. Any other name below the base
 * (`/-/next/nonsense`) is no page: the not-found page at once, not an owner page that asks Forgejo twice for a user
 * that does not exist (QA verify3).
 */
const nextOwnerRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next/$owner',
  beforeLoad: ({context: {app}, params, search}) => {
    const login = params.owner.toLowerCase();
    const known = untracked(() => [...app.session?.data.pool.model('User').all() ?? []].some((u) => u.data.login.toLowerCase() === login));
    if (!known) return;
    const q = new URLSearchParams(search).toString();
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack's redirect protocol
    throw redirect({href: sitePath(app.config, `/${encodeURIComponent(params.owner)}${q ? `?${q}` : ''}`), replace: true});
  },
  component: ShellNotFound,
});

/** A repository's address below the base (`/-/next/{owner}/{repo}[/…]`) is its canonical page. */
const nextRepoRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/-/next/$owner/$repo/$',
  beforeLoad: ({context: {app}, params}) => {
    const rest = (params._splat ?? '').replace(/^\/+|\/+$/g, '');
    const to = nextPathOf(`/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}${rest ? `/${rest}` : ''}`);
    // An address that names no page of the app: the not-found page (with the classic page, if any).
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack's redirect protocol
    if (to) throw redirect({href: sitePath(app.config, to), replace: true});
  },
  component: ShellNotFound,
});

/**
 * Any other address inside the shell: the not-found page, with the shell around it (and the classic page) — except
 * a repository's code address (`/{owner}/{repo}/src/branch/main/README.md`, `commits/…`, `compare/a...b`,
 * `pulls/9/files`; spaRoutes `{code}`), which is the app's page for it: a code view below the base, a pull
 * request's tab. A pasted link stays in the app. (A catch-all, not a `/$owner/$repo/$` route: that one would also
 * match a repository's home with an empty rest.)
 */
const notFoundRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '$',
  beforeLoad: ({context: {app}, params}) => {
    const path = `/${(params._splat ?? '').replace(/^\/+|\/+$/g, '')}`;
    const segs = path.split('/').filter(Boolean);
    const to = segs.length > 2 ? nextPathOf(path) : undefined;
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack's redirect protocol
    if (to && to !== path) throw redirect({href: sitePath(app.config, to), replace: true});
  },
  component: ShellNotFound,
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
    repoHomeRoute, repoIssuesRoute, repoPullsRoute, repoIssueRoute, repoPullRoute, boardsRoute, boardRoute, codeRoute,
    ownerRoute, nextOwnerRoute, nextRepoRoute, notFoundRoute,
  ]),
  ...devRoutes,
]);

/**
 * The views most sessions go to next, loaded one per idle period once the app has painted: the rest of the bundle
 * streams in behind the first view, and the first G N or row click evaluates no module on the interaction (QA
 * round 2: ~10 ms of a 4x-slowed navigation). Heavier views (code, boards) load on intent (defaultPreload) or use.
 */
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
  // Whether the navigation under way goes back or forward in the history, or is the first load (a reload): its
  // page's scroll is restored.
  let traversal = true;
  const router = createRouter({
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
    // Back to a list comes back to where it was scrolled (the page's scroll container: PageBody), after the render.
    // A new page starts at the top: that reset happens before the new page mounts (below), while the old one's
    // layout is clean — after the render it forced a synchronous layout of the whole new page inside the
    // navigation's task (55–65 ms at 4× CPU, QA verify3). A link to an anchor (#…) is scrolled to by the router.
    scrollRestoration: ({location}) => traversal || location.hash !== '',
    scrollToTopSelectors: [PAGE_SCROLLER],
    // Plain query strings, as the classic UI writes them (`?labels=11,-3&milestone=4`): values stay strings (the
    // routes' validators parse them; `?q=8` is the text "8"), never JSON-quoted (`labels=%2211%22`).
    parseSearch: parsePlainSearch,
    stringifySearch: stringifySearchWith(JSON.stringify),
    ...(history ? {history} : {}),
  });
  // Back, forward and history.go return to a history entry this tab has shown (its key, which every push and
  // replace makes new); the first load (a reload) restores its page too. Not router.history.subscribe: a
  // subscriber added before the router's own left the first boot after signing in on the splash; nor popstate,
  // which arrives after the router started the navigation.
  // A navigation may start loading twice (the history's subscriber, then the router's own): the same key keeps
  // its answer.
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

/** Route ids, for views that read their own params (`useParams({from})`). */
export const ROUTES = {
  repoHome: repoHomeRoute.id,
  repoIssues: repoIssuesRoute.id,
  repoPulls: repoPullsRoute.id,
  repoIssue: repoIssueRoute.id,
  repoPull: repoPullRoute.id,
  myIssues: myIssuesRoute.id,
  myPulls: myPullsRoute.id,
  code: codeRoute.id,
} as const;
