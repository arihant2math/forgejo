// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Classic URLs ⇄ the app's routes (pure). The app renders Forgejo's
// canonical URLs where it can (spaRoutes) and mirrors the classic shape below
// its base everywhere else (`/-/next/code/{owner}/{repo}/src/branch/main/…/-`,
// `/-/next/{owner}`), so most mappings drop or add a prefix:
//
//   nextPathOf(classic)  a link Forgejo rendered (markdown, a mention) → the
//                        app's page for it, or undefined (open it classic);
//   classicPathOf(path)  the page on screen → its classic page ("Open in the
//                        classic UI", switching UIs);
//   classicOfLocation    the same with the query (a list's filters) kept.
//
// Paths here are site paths (without the instance's sub-path).

import {END, parseCodePath} from '../code/refs.ts';
import {isOwnerName, isSpaRoute, NAME} from '../sw/routes.ts';

export {isOwnerName};

function segments(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

const enc = (s: string) => encodeURIComponent(s);

/** A repository's code view path (below the base, ending in END). `rest` is the classic path after the repository. */
export function codePath(owner: string, repo: string, rest: string): string {
  const tail = rest.replace(/^\/+|\/+$/g, '');
  return `/-/next/code/${enc(owner)}/${enc(repo)}/${tail ? `${tail.split('/').map(enc).join('/')}/` : ''}${END}`;
}

/**
 * The app's page for a classic site path, or undefined when the app has none (the classic page is the
 * place). `search` carries over for the lists (filters) and becomes the pull request's tab.
 */
export function nextPathOf(path: string): string | undefined {
  // Encoded dots, slashes and backslashes would decode into another path than the one checked.
  if (/%(?:2e|2f|5c)/i.test(path)) return undefined;
  const segs = segments(path);
  if (segs.length === 0) return '/';
  const [a = '', b = '', c, ...rest] = segs;
  if (segs.length === 1) {
    if (a === 'notifications' || a === 'issues' || a === 'pulls') return `/${a}`;
    return isOwnerName(a) ? `/${enc(a)}` : undefined;
  }
  // Boards: /{owner}/{repo}/projects/{id}, /{org}/-/projects/{id}, /{user}/-/projects/{id}.
  if (segs.length === 4 && c === 'projects' && /^[1-9]\d{0,15}$/.test(rest[0] ?? '') && isOwnerName(a)) return `/-/next/projects/${rest[0] ?? ''}`;
  if (!isOwnerName(a) || !NAME.test(b)) return undefined;
  const repoPath = `/${enc(a)}/${enc(b)}`;
  if (c === undefined) return repoPath;
  if (c === 'issues' || c === 'pulls') {
    const [n, sub] = rest;
    if (n === undefined) return `${repoPath}/${c}`;
    if (!/^[1-9]\d{0,15}$/.test(n)) return undefined;
    if (rest.length === 1) return `${repoPath}/${c}/${n}`;
    // /pulls/{n}/files|commits|checks → the pull request's tab.
    if (c === 'pulls' && rest.length === 2 && (sub === 'files' || sub === 'commits' || sub === 'checks')) return `${repoPath}/pulls/${n}?tab=${sub}`;
    return undefined;
  }
  const code = [c, ...rest].join('/');
  return parseCodePath(code) ? codePath(a, b, code) : undefined;
}

/**
 * The app's page for a classic address with its query (a site path: "/acme/atlas/issues?state=closed"), Home
 * when the app has none. A list keeps its filters (another page's query is the classic page's own, such as a
 * profile's tab); anything that is not a local path is Home.
 */
export function appPageOf(classic: string): string {
  if (!classic.startsWith('/') || classic.startsWith('//')) return '/';
  const at = classic.search(/[?#]/);
  const path = at < 0 ? classic : classic.slice(0, at);
  const query = at < 0 || classic[at] === '#' ? '' : classic.slice(at + 1).split('#')[0] ?? '';
  const mapped = nextPathOf(path);
  if (mapped === undefined) return '/';
  return query && !mapped.includes('?') && isListPath(mapped) ? `${mapped}?${query}` : mapped;
}

/** A repository's sections only the classic UI has (its More menu links them). */
const CLASSIC_SECTIONS = new Set(['wiki', 'activity', 'projects', 'settings', 'milestones', 'labels', 'packages', 'forks', 'stars', 'watchers', 'graph', 'find']);

/**
 * Whether a classic address is a page the classic UI is known to have and the app does not: a repository's
 * classic-only section. An address below the base the app cannot map (`/-/next/acme/atlas/foo`) is no promise
 * that the classic UI has it.
 */
export function classicHas(path: string): boolean {
  const [a = '', b = '', c] = segments(path);
  return isOwnerName(a) && NAME.test(b) && c !== undefined && CLASSIC_SECTIONS.has(c);
}

/** What classicPathOf needs to know about boards (the pool answers). */
export interface BoardPlace {
  /** The board's repository ("owner/name"), or its owner's login. */
  repo?: string | undefined;
  owner?: string | undefined;
}

/**
 * The classic page of an app route (site path, without search). Canonical routes are their own classic URL;
 * the app's pages below the base map back to the classic shape. `board` resolves a board's place, `login`
 * is the viewer (the classic page of the boards list is their projects).
 */
export function classicPathOf(path: string, ctx: {board?: (id: number) => BoardPlace | undefined; login?: string | undefined} = {}): string {
  const segs = segments(path);
  if (segs[0] !== '-' || segs[1] !== 'next') return path || '/';
  const [, , a, ...rest] = segs;
  if (a === undefined || a === 'callback') return '/';
  if (a === 'code') {
    const [owner = '', repo = '', ...tail] = rest;
    if (tail.at(-1) === END) tail.pop();
    return `/${[owner, repo, ...tail].map(enc).join('/')}`;
  }
  if (a === 'projects') {
    const id = Number(rest[0]);
    const place = Number.isSafeInteger(id) ? ctx.board?.(id) : undefined;
    if (place?.repo) return `/${place.repo.split('/').map(enc).join('/')}/projects/${String(id)}`;
    if (place?.owner) return `/${enc(place.owner)}/-/projects/${String(id)}`;
    return ctx.login ? `/${enc(ctx.login)}/-/projects` : '/';
  }
  if (a === 'boards') return ctx.login ? `/${enc(ctx.login)}/-/projects` : '/';
  // /-/next/{owner}[/{repo}] (redirects to the canonical page).
  return `/${[a, ...rest].map(enc).join('/')}`;
}

/**
 * The classic page of the page on screen, with its query: a canonical route keeps every parameter (the
 * classic UI reads the same `type`, `state`, `labels`, `filter`, …); a page below the base maps to another
 * shape and drops it.
 */
export function classicOfLocation(path: string, search: string, ctx: Parameters<typeof classicPathOf>[1] = {}): string {
  const mapped = classicPathOf(path, ctx);
  const q = search.replace(/^\?/, '');
  return mapped === (path || '/') && q ? `${mapped}?${q}` : mapped;
}

/** Whether a site path (and query) is one of the app's canonical routes (the server serves the app for it: spaRoutes). */
export function isCanonical(path: string, search = ''): boolean {
  return isSpaRoute(path, search);
}

/**
 * Whether a site path is a list an issue can be opened from (an issue's Esc goes back there): the inbox, the
 * viewer's issues and pull requests, a repository's lists, a board, the boards.
 */
export function isListPath(path: string): boolean {
  const segs = segments(path);
  if (segs.length === 1) return segs[0] === 'notifications' || segs[0] === 'issues' || segs[0] === 'pulls';
  if (segs[0] === '-') return segs[1] === 'next' && (segs[2] === 'boards' || (segs[2] === 'projects' && segs.length === 4));
  return segs.length === 3 && isOwnerName(segs[0] ?? '') && (segs[2] === 'issues' || segs[2] === 'pulls');
}

/** The repository ("owner/name", lower case) a route belongs to, if any (sidebar highlighting, the tabs). */
export function repoOfPath(path: string): string | undefined {
  const segs = segments(path);
  if (segs[0] === '-') {
    if (segs[1] === 'next' && segs[2] === 'code' && segs[3] && segs[4]) return `${segs[3]}/${segs[4]}`.toLowerCase();
    return undefined;
  }
  const [a = '', b = '', c] = segs;
  if (segs.length < 2 || !isOwnerName(a) || !NAME.test(b)) return undefined;
  if (c !== undefined && c !== 'issues' && c !== 'pulls') return undefined;
  return `${a}/${b}`.toLowerCase();
}
