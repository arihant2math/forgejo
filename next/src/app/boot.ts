// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Read the local session and load the route before rendering; the static shell stays visible until then.
// Token refresh and sync run in the background.

import {optIn} from '../auth/optin.ts';
import {isSpaRoute, sitePathOf} from '../sw/routes.ts';
import {loadConfig, uiPath} from './config.ts';
import {isChunkError} from './reload.ts';
import {createAppRouter, type AppRouter} from './router.tsx';
import {showingNotFound} from './shell/PageHeader.tsx';
import {followOtherTabs, openSession} from './session.ts';
import {readSplash, writeSplash} from './splash.ts';
import {type App, createApp} from './store.ts';

export async function bootApp(): Promise<{app: App; router: AppRouter}> {
  const config = await loadConfig();
  const callback = location.pathname.startsWith(uiPath(config, 'callback'));
  // Built before the session exists, so the route's view chunk loads while IndexedDB opens.
  const router = createAppRouter(createApp(config, undefined));
  preloadRoute(router, config);
  // Load the queue in parallel with IndexedDB without adding it to the boot bundle.
  const queueModule = callback ? undefined : import('../intents/session.ts');
  queueModule?.catch(() => undefined);
  const session = callback ? undefined : await openSession(config);
  const app = createApp(config, session);
  router.update({...router.options, context: {app}});
  // Apply queued overlays before the first frame; an empty queue must not delay boot.
  const queue = session && queueModule ? startQueue(app, session, queueModule) : undefined;
  await Promise.all([router.load(), queue]);
  const failed = router.state.matches.find((m) => m.status === 'error' && isChunkError(m.error));
  if (failed) throw failed.error;
  // The single-use callback must not reload from its own sign-in broadcast.
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

/** Preload the current route's view; at the base URL, the route the last visit ended on. */
function preloadRoute(router: AppRouter, config: App['config']): void {
  try {
    const sub = config.app_sub_url;
    let path = location.pathname.startsWith(sub) ? location.pathname.slice(sub.length) || '/' : location.pathname;
    const last = readSplash().route;
    if (`${sub}${path}`.replace(/\/$/, '') === config.base.replace(/\/$/, '') && last?.startsWith(`${sub}/`)) {
      path = last.slice(sub.length).split('?')[0] ?? '/';
    }
    for (const m of router.matchRoutes(path, {})) {
      const route = (router.routesById as Record<string, {options: {component?: unknown}} | undefined>)[m.routeId];
      const component = route?.options.component as {preload?: () => Promise<void>} | undefined;
      void component?.preload?.().catch(() => undefined);
    }
  } catch {
    // Only a head start.
  }
}

function started(app: App, router: AppRouter): void {
  followOtherTabs(app);
  const s = app.session;
  if (!s) return;
  s.data.on('wrongUser', ({viewerId}) => {
    console.error(`livesync: the session belongs to user ${String(viewerId)}, not to this device's user ${String(s.userId)}`);
  });
  // Only server-sent opt-in documents renew the cookie; offline fallbacks must not opt users back in.
  const site = sitePathOf(location.pathname, app.config.app_sub_url);
  const cached = document.querySelector('meta[name="forgejo-next-cached"]') !== null;
  if (!cached && (location.pathname.replace(/\/$/, '') === app.config.base.replace(/\/$/, '') || (site !== undefined && isSpaRoute(site)))) void optIn(app.config);
  const remember = () => {
    const leaf = router.state.matches.at(-1);
    const shape = leaf?.staticData.skeleton;
    if (!shape || showingNotFound()) return;
    const header = leaf.staticData.header ?? 'page';
    writeSplash({route: `${location.pathname}${location.search}`, skeleton: {shape, rows: shape === 'list' ? listRows : 0, header}});
  };
  remember();
  router.subscribe('onResolved', remember);
  // Release sidebar focus after navigation so page shortcuts and Enter target the new page.
  let lastPath = location.pathname;
  router.subscribe('onResolved', () => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    // Blur after paint to avoid forcing synchronous layout during navigation.
    requestAnimationFrame(() => {
      setTimeout(() => {
        const a = document.activeElement;
        if (a instanceof HTMLElement && a.closest('aside[aria-label="Sidebar"]')) a.blur();
      });
    });
  });
}

let listRows = 0;

/** Records the visible row count for the next boot's list skeleton. */
export function rememberListRows(rows: number): void {
  listRows = Math.max(0, Math.round(rows));
  const {header} = readSplash().skeleton ?? {};
  writeSplash({skeleton: {shape: 'list', rows: listRows, ...(header ? {header} : {})}});
}
