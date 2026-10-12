// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// No UI imports: actions and menus can use classic URLs without loading primitives.

import {sitePath, uiPath} from './config.ts';
import {classicOfLocation, isCanonical} from './paths.ts';
import type {App} from './store.ts';

/** The URL of a classic page (`path`: a site path, with or without a query). */
export function classicHref(app: App, path: string): string {
  const q = path.indexOf('?');
  const bare = q < 0 ? path : path.slice(0, q);
  const search = new URLSearchParams(q < 0 ? '' : path.slice(q + 1));
  if (isCanonical(bare)) search.set('ui', 'classic');
  const s = search.toString();
  return sitePath(app.config, `${bare}${s ? `?${s}` : ''}`);
}

export const CLASSIC_HINT = 'Opens in the classic Forgejo UI';

/** Returns the classic counterpart with canonical filters preserved and app-only routes mapped. */
export function classicOfHere(app: App, path: string, search = ''): string {
  const s = app.session;
  if (!s) return classicOfLocation(path, search);
  const pool = s.data.pool;
  return classicOfLocation(path, search, {
    login: pool.model('User').get(s.userId)?.get('login'),
    defaultBranch: (owner, repo) => {
      const full = `${owner}/${repo}`.toLowerCase();
      for (const r of pool.model('Repository').all()) if (r.get('full_name').toLowerCase() === full) return r.get('default_branch') || undefined;
      return undefined;
    },
    board: (id) => {
      const p = pool.model('Project').get(id);
      if (!p) return undefined;
      const repo = pool.model('Repository').get(p.get('repo_id'))?.get('full_name');
      return repo ? {repo} : {owner: pool.model('User').get(p.get('owner_id'))?.get('login')};
    },
  });
}

/** Disables opt-in and opens the corresponding classic page. */
export function switchToClassic(app: App): void {
  const sub = app.config.app_sub_url;
  const site = location.pathname.startsWith(`${sub}/`) || location.pathname === sub ? location.pathname.slice(sub.length) || '/' : '/';
  const back = sitePath(app.config, classicOfHere(app, site, location.search));
  const go = () => {
    location.assign(`${uiPath(app.config, 'opt-out')}?redirect=${encodeURIComponent(back)}`);
  };
  // Unregister asynchronously so the service worker cannot block leaving.
  void import('./sw.ts').then((m) => m.removeServiceWorker(app)).catch(() => undefined).finally(go);
}
