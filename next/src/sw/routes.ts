// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the service worker (sw.ts) decides about a request, as pure
// functions (tested in routes.test.ts against B8's spaRoutes table).

/** The service worker's caches are named with this prefix and the build version. */
export const CACHE_PREFIX = 'forgejo-next-';

export function cacheName(version: string): string {
  return `${CACHE_PREFIX}${version}`;
}

/** The build version index.html carries (the service worker checks the shell it caches is its build's). */
export const BUILD_META = 'forgejo-next-build';

export function buildOf(html: string): string | undefined {
  return new RegExp(`<meta name="${BUILD_META}" content="([\\w-]+)"`).exec(html)?.[1];
}

/** The path below the instance's sub-path ("/owner/repo/issues/1"), or undefined outside it. */
export function sitePathOf(pathname: string, subUrl: string): string | undefined {
  if (!subUrl) return pathname;
  if (pathname === subUrl) return '/';
  return pathname.startsWith(`${subUrl}/`) ? pathname.slice(subUrl.length) : undefined;
}

// Forgejo's usable names (user_model.IsUsableUsername / repo_model.IsUsableRepoName), loosely: the
// worker only decides between the app and the offline page, the server decides for real online.
const NAME = /^(?![.-])[\w.-]+$/;

/**
 * Whether a site path is a canonical route the app renders (B8 spaRoutes):
 * `/`, `/notifications`, `/issues`, `/pulls`, `/{owner}/{repo}/issues[/{n}]`,
 * `/{owner}/{repo}/pulls[/{n}]`. Keep in step with routers/livesync/spa.go.
 */
export function isSpaRoute(path: string): boolean {
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return true;
  if (segs.length === 1) return ['notifications', 'issues', 'pulls'].includes(segs[0] ?? '');
  if (segs.length !== 3 && segs.length !== 4) return false;
  const [owner = '', repo = '', kind = '', n] = segs;
  if (!NAME.test(owner) || !NAME.test(repo) || owner === 'api' || (kind !== 'issues' && kind !== 'pulls')) return false;
  return n === undefined || /^[1-9]\d{0,17}$/.test(n);
}

/** How the worker answers a same-origin GET. */
export type Strategy = 'asset' | 'navigate' | 'pass';

export function strategy(req: {method: string; mode: string; url: string}, origin: string, base: string): Strategy {
  if (req.method !== 'GET') return 'pass';
  const url = new URL(req.url);
  if (url.origin !== origin) return 'pass';
  if (url.pathname.startsWith(`${base}assets/`)) return 'asset';
  if (req.mode === 'navigate') return 'navigate';
  return 'pass';
}
