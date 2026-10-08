// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Boot (PLAN §5.2): config → the local session (IndexedDB, before any
// network) → the router with the current route's chunk loaded → one render.
// The static boot shell stays on screen until then; nothing renders through
// Suspense (F1). Network work (token refresh, sync) starts in the background.

import {runInAction} from 'mobx';
import {optIn} from '../auth/optin.ts';
import {loadConfig, uiPath} from './config.ts';
import {isChunkError} from './reload.ts';
import {createAppRouter, type AppRouter} from './router.tsx';
import {followOtherTabs, openSession} from './session.ts';
import {writeSplash} from './splash.ts';
import {type App, createApp} from './store.ts';

export async function bootApp(): Promise<{app: App; router: AppRouter}> {
  const config = await loadConfig();
  const callback = location.pathname.startsWith(uiPath(config, 'callback'));
  const session = callback ? undefined : await openSession(config);
  const app = createApp(config, session);
  const router = createAppRouter(app);
  await router.load();
  const failed = router.state.matches.find((m) => m.status === 'error' && isChunkError(m.error));
  if (failed) throw failed.error;
  started(app, router);
  return {app, router};
}

/** Background work once the app is up. */
function started(app: App, router: AppRouter): void {
  followOtherTabs(app);
  const s = app.session;
  if (!s) return;
  void s.data.countIntents().then((n) => {
    runInAction(() => {
      app.ui.pendingIntents = n;
    });
  }, () => undefined);
  s.data.on('wrongUser', ({viewerId}) => {
    console.error(`livesync: the session belongs to user ${String(viewerId)}, not to this device's user ${String(s.userId)}`);
  });
  // Canonical URLs reload into this UI only with the opt-in cookie.
  void optIn(app.config);
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
