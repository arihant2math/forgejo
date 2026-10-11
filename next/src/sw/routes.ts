// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// What the service worker (sw.ts) decides about a request, as pure
// functions (tested in routes.test.ts against B8's spaRoutes table).

import {abbreviatedCommit, parseCodePath} from '../code/refs.ts';
import {parseWikiRest} from '../features/wiki/paths.ts';

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
export const NAME = /^(?![.-])[\w.-]+$/;

/**
 * First segments that are Forgejo routes, never an owner (user_model's reservedUsernames). The server decides
 * for real; this keeps the app from claiming `/explore` or `/user/settings` as a profile or a repository.
 */
const RESERVED = new Set([
  '-', '.well-known', 'api', 'metrics', 'v2', 'assets', 'attachments', 'avatar', 'avatars', 'repo-avatars', 'captcha', 'login', 'org',
  'repo', 'user', 'admin', 'explore', 'issues', 'pulls', 'milestones', 'notifications', 'report_abuse', 'favicon.ico', 'manifest.json',
  'robots.txt', 'sitemap.xml', 'ssh_info', 'swagger.v1.json', 'ghost', 'gitea-actions', 'forgejo-actions', 'actor',
]);

/** user_model's reservedUserPatterns: `/{user}.keys`, `.gpg`, `.rss`, `.atom`, `.png` are the user's files. */
const RESERVED_SUFFIX = /\.(?:keys|gpg|rss|atom|png)$/i;

/** Whether a segment can be an owner's name (a user or an organization). */
export function isOwnerName(s: string): boolean {
  return NAME.test(s) && !RESERVED.has(s.toLowerCase()) && !RESERVED_SUFFIX.test(s);
}

/** A repository's settings sections the app renders (`/{owner}/{repo}/settings/{section}`; spa.go spaRoutes). */
export const SETTINGS_SECTIONS: readonly string[] = ['collaboration', 'branches', 'hooks', 'keys'];


/**
 * Whether a site path (and its query) is a canonical route the app renders (B8 spaRoutes):
 * `/`, `/notifications`, `/issues`, `/pulls`, `/repo/create`, `/org/create`, `/{owner}`, `/{owner}/{repo}`, `/{owner}/{repo}/issues[/{n}]`,
 * `/{owner}/{repo}/pulls[/{n}]`, `/{owner}/{repo}/activity[/{period or graph}]`, the wiki (`/{owner}/{repo}/wiki[/…]`),
 * `/{owner}/{repo}/labels`, `/{owner}/{repo}/watchers`, `/{owner}/{repo}/milestones[/new]`, `/{owner}/{repo}/milestone/{n}[/edit]`,
 * `/{owner}/{repo}/settings[/{section}]`, code addresses, the viewer's settings (`/user/settings[/account|appearance|keys]`).
 * `?ui=classic` asks for the classic page, and so does an owner's profile tab (`/{owner}?tab=activity`; the app shows the
 * repositories) or a wiki page's revisions (`?action=_revision`).
 * Keep in step with routers/livesync/spa.go.
 */
export function isSpaRoute(path: string, search = ''): boolean {
  const q = new URLSearchParams(search);
  if (q.get('ui') === 'classic') return false;
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return true;
  if (segs.length === 1) {
    const [a = ''] = segs;
    if (['notifications', 'issues', 'pulls'].includes(a)) return true;
    return isOwnerName(a) && !profileTab(q);
  }
  const [owner = '', repo = '', kind, n] = segs;
  // The viewer's settings pages (`user` is a reserved name, never an owner).
  if (owner === 'user') return repo === 'settings' && (kind === undefined || (segs.length === 3 && USER_SETTINGS_PAGES.has(kind)));
  // The new repository and organization forms ("repo" and "org" are reserved: never an owner).
  if (segs.length === 2 && (owner === 'repo' || owner === 'org') && repo === 'create') return true;
  if (!isOwnerName(owner) || !NAME.test(repo)) return false;
  if (kind === undefined) return true;
  // The wiki's pages and views; a page's revisions are the classic page's (spa.go wikiClassic).
  if (kind === 'wiki') return parseWikiRest(segs.slice(3).map(decodeSegment)) !== undefined && q.get('action') !== '_revision';
  // A code address, or a pull request's Files or Commits tab (spa.go codeAddress): the app's code view.
  if (codeAddress(segs.slice(2))) return true;
  if (kind === 'settings') return segs.length === 3 || (segs.length === 4 && SETTINGS_SECTIONS.includes(n ?? ''));
  // Labels, milestones, a milestone and its form (features/meta).
  if (kind === 'labels') return segs.length === 3;
  // Its watchers (features/repo/Watchers.tsx).
  if (kind === 'watchers') return segs.length === 3;
  if (kind === 'milestones') return segs.length === 3 || (segs.length === 4 && n === 'new');
  if (kind === 'milestone') return /^[1-9]\d{0,17}$/.test(n ?? '') && (segs.length === 4 || (segs.length === 5 && segs[4] === 'edit'));
  if (segs.length > 4) return false;
  if (kind === 'activity') return n === undefined || ACTIVITY_PAGES.has(n);
  if (kind !== 'issues' && kind !== 'pulls') return false;
  // An issue created offline is at "new-<uuid>" until Forgejo numbers it (features/issue/paths.ts TEMP_PATH).
  return n === undefined || (kind === 'issues' && !n.includes('.') && n !== '') || /^[1-9]\d{0,17}$/.test(n);
}

/** What may follow `/user/settings` in the app (spa.go spaRoutes): its account, appearance and keys pages. */
export const USER_SETTINGS_PAGES: ReadonlySet<string> = new Set(['account', 'appearance', 'keys']);

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * What may follow `/{owner}/{repo}/activity`: a period of the Pulse (spa.go activityPeriods,
 * features/activity/pulse.ts PERIODS) or one of its graphs.
 */
const ACTIVITY_PAGES = new Set([
  'daily', 'halfweekly', 'weekly', 'monthly', 'quarterly', 'semiyearly', 'yearly', 'contributors', 'code-frequency', 'recent-commits',
]);

/** spa.go `codeAddress`: what follows a repository in a code page's address (the app's code views mirror it). */
function codeAddress(rest: string[]): boolean {
  const [head, second] = rest;
  if (head === 'pulls') return rest.length === 3 && /^[1-9]\d{0,17}$/.test(second ?? '') && (rest[2] === 'files' || rest[2] === 'commits');
  if (head === 'src' || head === 'blame' || head === 'commits') {
    if (rest.length === 1) return true;
    return (second === 'branch' || second === 'tag' || second === 'commit') && rest.length >= 3 && parseCodePath(rest.join('/')) !== undefined;
  }
  // A commit by an abbreviation of its SHA too (the app looks it up).
  return head !== undefined && head !== 'src' && (parseCodePath(rest.join('/')) !== undefined || (head === 'commit' && abbreviatedCommit(rest.join('/')) !== undefined));
}

/** The owner page's sections the app has (spa.go `appProfileTabs`): `/{owner}?tab=stars` is the app's. */
const APP_PROFILE_TABS: ReadonlySet<string> = new Set(['', 'repositories', 'overview', 'stars', 'watching', 'boards', 'people', 'teams']);

/** A tab of the classic profile the app's owner page does not have (spa.go `profileTab`): `?tab=activity`. */
function profileTab(q: URLSearchParams): boolean {
  return !APP_PROFILE_TABS.has(q.get('tab') ?? '');
}

/** How the worker answers a same-origin GET. */
export type Strategy = 'asset' | 'navigate' | 'avatar' | 'pass';

/** Forgejo's avatar URLs (users, organizations, repositories), below the sub-path. */
const AVATAR = /^\/(?:avatars?|repo-avatars)\//;

/** Whether a site path is one of Forgejo's avatars. */
export function isAvatarPath(site: string): boolean {
  return AVATAR.test(site);
}

export function strategy(req: {method: string; mode: string; url: string; destination?: string}, origin: string, base: string, sub = ''): Strategy {
  if (req.method !== 'GET') return 'pass';
  const url = new URL(req.url);
  if (url.origin !== origin) return 'pass';
  if (url.pathname.startsWith(`${base}assets/`)) return 'asset';
  if (req.mode === 'navigate') return 'navigate';
  const site = sitePathOf(url.pathname, sub);
  if (req.destination === 'image' && site !== undefined && AVATAR.test(site)) return 'avatar';
  return 'pass';
}

/** The avatars' cache (kept across builds; dropped with the others by the kill switch). */
export const AVATAR_CACHE = `${CACHE_PREFIX}avatars`;
