// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Boot (PLAN §5.2): config → the local session (IndexedDB, before any
// network) → the router with the current route's chunk loaded → one render.
// The static boot shell stays on screen until then; nothing renders through
// Suspense (F1). Network work (token refresh, sync) starts in the background.

import {createMemoryHistory} from '@tanstack/react-router';
import {optIn} from '../auth/optin.ts';
import {isSpaRoute, sitePathOf} from '../sw/routes.ts';
import {loadConfig, uiPath} from './config.ts';
import {isChunkError} from './reload.ts';
import {createAppRouter, type AppRouter} from './router.tsx';
import {followOtherTabs, openSession} from './session.ts';
import {readSplash, writeSplash} from './splash.ts';
import {type App, createApp} from './store.ts';

export async function bootApp(): Promise<{app: App; router: AppRouter}> {
  const config = await loadConfig();
  const callback = location.pathname.startsWith(uiPath(config, 'callback'));
  preloadRoute(app0(config));
  // The offline queue's chunk loads while IndexedDB is read (it is not on the boot route's bundle).
  const queueModule = callback ? undefined : import('../intents/session.ts');
  queueModule?.catch(() => undefined);
  const session = callback ? undefined : await openSession(config);
  const app = createApp(config, session);
  const router = createAppRouter(app);
  // Pending changes are in the overlay before the first frame (they show at once after a reload);
  // with none queued (the usual case) the first frame does not wait for the queue. Never fatal.
  const queue = session && queueModule ? startQueue(app, session, queueModule) : undefined;
  await Promise.all([router.load(), queue]);
  const failed = router.state.matches.find((m) => m.status === 'error' && isChunkError(m.error));
  if (failed) throw failed.error;
  // The callback page signs in and leaves; it must not follow the other tabs (its own
  // sign-in broadcast would reload it before it leaves, and the code is single-use).
  if (!callback) started(app, router);
  return {app, router};
}

async function startQueue(app: App, session: NonNullable<App['session']>, m: Promise<{startEditing: (app: App) => Promise<unknown>}>): Promise<void> {
  const pending = await session.data.countIntents().catch(() => 1);
  const started = m.then((q) => q.startEditing(app)).catch((err: unknown) => {
    console.error('intents: the queue could not be started', err);
  });
  if (pending > 0) await started;
}

function app0(config: App['config']): App {
  return createApp(config, undefined);
}

/**
 * Starts loading the chunk of the view this boot will render while
 * IndexedDB is read (the router only learns the route after the session is
 * open): only Home is modulepreloaded, and a reload usually lands on another
 * canonical route. The base URL resumes the splash route, so that one.
 */
function preloadRoute(app: App): void {
  try {
    const sub = app.config.app_sub_url;
    let path = location.pathname.startsWith(sub) ? location.pathname.slice(sub.length) || '/' : location.pathname;
    const last = readSplash().route;
    if (`${sub}${path}`.replace(/\/$/, '') === app.config.base.replace(/\/$/, '') && last?.startsWith(`${sub}/`)) {
      path = last.slice(sub.length).split('?')[0] ?? '/';
    }
    const probe = createAppRouter({...app, config: {...app.config, app_sub_url: ''}}, createMemoryHistory());
    for (const m of probe.matchRoutes(path, {})) {
      const route = (probe.routesById as Record<string, {options: {component?: unknown}} | undefined>)[m.routeId];
      const component = route?.options.component as {preload?: () => Promise<void>} | undefined;
      void component?.preload?.().catch(() => undefined);
    }
  } catch {
    // Only a head start.
  }
}

/** Background work once the app is up. */
function started(app: App, router: AppRouter): void {
  followOtherTabs(app);
  const s = app.session;
  if (!s) return;
  s.data.on('wrongUser', ({viewerId}) => {
    console.error(`livesync: the session belongs to user ${String(viewerId)}, not to this device's user ${String(s.userId)}`);
  });
  // Canonical URLs reload into this UI only with the opt-in cookie. Not from a page the app does not
  // have (the service worker's offline fallback): that would opt a user who left back in.
  // Nor from the service worker's cached shell (marked): only a document the server sent proves the opt-in.
  const site = sitePathOf(location.pathname, app.config.app_sub_url);
  const cached = document.querySelector('meta[name="forgejo-next-cached"]') !== null;
  if (!cached && (location.pathname === app.config.base || (site !== undefined && isSpaRoute(site)))) void optIn(app.config);
  // The splash for the next boot: the route and the shape of its page.
  const remember = () => {
    const leaf = router.state.matches.at(-1);
    const shape = leaf?.staticData.skeleton;
    if (!shape) return;
    writeSplash({route: `${location.pathname}${location.search}`, skeleton: {shape, rows: shape === 'list' ? listRows : 0}});
  };
  remember();
  router.subscribe('onResolved', remember);
}

let listRows = 0;

/**
 * A list view reports how many rows it shows, so that the next boot's
 * skeleton has as many (F4's lists call this; F3's pages show none).
 */
export function rememberListRows(rows: number): void {
  listRows = Math.max(0, Math.round(rows));
  writeSplash({skeleton: {shape: 'list', rows: listRows}});
}
