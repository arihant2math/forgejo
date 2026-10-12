// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Mappings use site paths without the instance sub-path.
// Canonical routes keep Forgejo's URLs; app-only routes map below the base.

import {legacyCodeSplat, parseCodePath} from '../code/refs.ts';
import {classicWikiPath, parseWikiRest, wikiActionView, wikiPath} from '../features/wiki/paths.ts';
import {isOwnerName, isSpaRoute, NAME, SETTINGS_SECTIONS, USER_SETTINGS_PAGES} from '../sw/routes.ts';

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

export interface RepoRef {
  id: number;
  owner: string;
  name: string;
}

/** API v1 repository path; rest is an already-encoded suffix, including its separator. */
export function apiRepoPath(owner: string, repo: string, rest = ''): string {
  return `/repos/${enc(owner)}/${enc(repo)}${rest}`;
}

export function apiRepoPathOf(ref: RepoRef, rest = ''): string {
  return apiRepoPath(ref.owner, ref.name, rest);
}

/** `rest` is the classic path after the repository. */
export function codePath(owner: string, repo: string, rest: string): string {
  const tail = rest.replace(/^\/+|\/+$/g, '');
  return `/${enc(owner)}/${enc(repo)}${tail ? `/${tail.split('/').map(enc).join('/')}` : ''}`;
}

/** Returns the app route for a classic site path, or undefined if the page is classic-only. */
export function nextPathOf(path: string): string | undefined {
  // Encoded dots, slashes and backslashes would decode into another path than the one checked.
  if (/%(?:2e|2f|5c)/i.test(path)) return undefined;
  const segs = segments(path);
  if (segs.length === 0) return '/';
  const [a = '', b = '', c, ...rest] = segs;
  if (a === 'explore' || a === 'search') return isSpaRoute(path) ? `/${segs.join('/')}` : undefined;
  if (segs.length === 1) {
    if (a === 'notifications' || a === 'issues' || a === 'pulls') return `/${a}`;
    return isOwnerName(a) ? `/${enc(a)}` : undefined;
  }
  if (a === 'user') {
    if (b !== 'settings' || rest.length > 0) return undefined;
    if (c === undefined) return '/user/settings';
    return USER_SETTINGS_PAGES.has(c) ? `/user/settings/${c}` : undefined;
  }
  if (segs.length === 2 && (a === 'repo' || a === 'org') && b === 'create') return `/${a}/create`;
  if (segs.length === 4 && c === 'projects' && /^[1-9]\d{0,15}$/.test(rest[0] ?? '') && isOwnerName(a)) return `/-/next/projects/${rest[0] ?? ''}`;
  if (!isOwnerName(a) || !NAME.test(b)) return undefined;
  const repoPath = `/${enc(a)}/${enc(b)}`;
  if (c === undefined) return repoPath;
  if (c === 'settings') {
    if (rest.length === 0) return `${repoPath}/settings`;
    return rest.length === 1 && SETTINGS_SECTIONS.includes(rest[0] ?? '') ? `${repoPath}/settings/${rest[0] ?? ''}` : undefined;
  }
  if (c === 'issues' || c === 'pulls') {
    const [n, sub] = rest;
    if (n === undefined) return `${repoPath}/${c}`;
    if (c === 'issues' && n === 'new' && rest.length === 1) return `${repoPath}/issues/new`;
    if (!/^[1-9]\d{0,15}$/.test(n)) return undefined;
    if (rest.length === 1) return `${repoPath}/${c}/${n}`;
    if (c === 'pulls' && rest.length === 2 && (sub === 'files' || sub === 'commits' || sub === 'checks')) return `${repoPath}/pulls/${n}?tab=${sub}`;
    return undefined;
  }
  if (c === 'wiki') {
    const v = parseWikiRest(rest);
    if (v === undefined) return undefined;
    return rest.length === 0 ? `${repoPath}/wiki` : wikiPath(a, b, v);
  }
  if (c === 'activity') return isSpaRoute(path) ? `${repoPath}/activity${rest[0] === undefined ? '' : `/${rest[0]}`}` : undefined;
  if (c === 'labels') return rest.length === 0 ? `${repoPath}/labels` : undefined;
  if (c === 'watchers') return rest.length === 0 ? `${repoPath}/watchers` : undefined;
  if (c === 'milestones') {
    if (rest.length === 0) return `${repoPath}/milestones`;
    if (rest.length === 1 && rest[0] === 'new') return `${repoPath}/milestones/new`;
    return rest.length === 2 && rest[1] === 'edit' && /^[1-9]\d{0,15}$/.test(rest[0] ?? '') ? `${repoPath}/milestone/${rest[0] ?? ''}/edit` : undefined;
  }
  if (c === 'milestone') {
    const [n, sub] = rest;
    if (n === undefined || !/^[1-9]\d{0,15}$/.test(n)) return undefined;
    if (rest.length === 1) return `${repoPath}/milestone/${n}`;
    return rest.length === 2 && sub === 'edit' ? `${repoPath}/milestone/${n}/edit` : undefined;
  }
  const code = [c, ...rest].join('/');
  return parseCodePath(code) ? codePath(a, b, code) : undefined;
}

/** Maps classic wiki action queries to app views; undefined for unsupported actions. */
export function wikiAddress(path: string, search: string): string | undefined {
  if (/%(?:2e|2f|5c)/i.test(path)) return undefined;
  const [a = '', b = '', c, ...rest] = segments(path);
  if (c !== 'wiki' || !isOwnerName(a) || !NAME.test(b)) return undefined;
  const v = parseWikiRest(rest);
  if (v === undefined) return undefined;
  const action = new URLSearchParams(search.replace(/^\?/, '')).get('action') ?? undefined;
  const to = wikiActionView(v, action);
  return to === v && rest.length === 0 ? `/${enc(a)}/${enc(b)}/wiki` : wikiPath(a, b, to);
}

/** Maps a local classic address to the app, preserving list filters; falls back to Home for unmapped or nonlocal paths. */
export function appPageOf(classic: string): string {
  if (!classic.startsWith('/') || classic.startsWith('//')) return '/';
  const at = classic.search(/[?#]/);
  const path = at < 0 ? classic : classic.slice(0, at);
  const query = at < 0 || classic[at] === '#' ? '' : classic.slice(at + 1).split('#')[0] ?? '';
  const mapped = wikiAddress(path, query) ?? nextPathOf(path) ?? nearestAppPage(path);
  if (mapped === undefined) return '/';
  return query && !mapped.includes('?') && (isListPath(mapped) || mapped === '/repo/create' || mapped.endsWith('/issues/new') || /^\/(?:search|explore)(?:\/|$)/.test(mapped) || /^\/[^/]+\/[^/]+\/(?:labels|milestones|watchers)$/.test(mapped)) ?
    `${mapped}?${query}` : mapped;
}

/** Uses the nearest related app page instead of sending a classic-only repository page to an unrelated Home. */
function nearestAppPage(path: string): string | undefined {
  if (/%(?:2e|2f|5c)/i.test(path)) return undefined;
  const [a = '', b = '', c] = segments(path);
  if (a === 'user' && b === 'settings') return '/user/settings';
  if (!isOwnerName(a) || !NAME.test(b) || b === '-') return undefined;
  if (c === 'releases' || c === 'tags') return codePath(a, b, c);
  if (c === 'projects') return '/-/next/boards';
  if (c === 'issues' || c === 'pulls') return `/${enc(a)}/${enc(b)}/${c}`;
  if (c === 'settings') return `/${enc(a)}/${enc(b)}/settings`;
  if (c === 'wiki') return `/${enc(a)}/${enc(b)}/wiki`;
  if (c === 'labels' || c === 'milestones' || c === 'milestone') return `/${enc(a)}/${enc(b)}/${c === 'labels' ? 'labels' : 'milestones'}`;
  return `/${enc(a)}/${enc(b)}`;
}

const CLASSIC_SECTIONS = new Set(['wiki', 'projects', 'settings', 'packages', 'forks', 'stars', 'graph', 'find']);

/** True only for known classic-only sections; an unmapped app address does not guarantee a classic page exists. */
export function classicHas(path: string): boolean {
  const [a = '', b = '', c] = segments(path);
  return isOwnerName(a) && NAME.test(b) && c !== undefined && CLASSIC_SECTIONS.has(c);
}

export interface BoardPlace {
  /** The board's repository ("owner/name"), or its owner's login. */
  repo?: string | undefined;
  owner?: string | undefined;
}

export interface ClassicContext {
  board?: (id: number) => BoardPlace | undefined;
  login?: string | undefined;
  /** A repository's default branch ("owner/name" as in the path). */
  defaultBranch?: (owner: string, repo: string) => string | undefined;
}

/** Maps a site path without search to classic; board context resolves ownership and login resolves the viewer's projects. */
export function classicPathOf(path: string, ctx: ClassicContext = {}): string {
  const segs = segments(path);
  if (segs[2] === 'wiki' && segs.length > 3 && isOwnerName(segs[0] ?? '')) {
    const v = parseWikiRest(segs.slice(3));
    if (v && v.view !== 'page') return classicWikiPath(segs[0] ?? '', segs[1] ?? '', v);
  }
  if (segs[0] !== '-' || segs[1] !== 'next') {
    const [owner = '', repo = '', ...tail] = segs;
    // The app's milestone editor is at /milestone/{n}/edit, the classic one at /milestones/{n}/edit.
    if (tail.length === 3 && tail[0] === 'milestone' && tail[2] === 'edit' && isOwnerName(owner)) return `/${[owner, repo, 'milestones', ...tail.slice(1)].map(enc).join('/')}`;
    const code = isOwnerName(owner) && NAME.test(repo) && tail.length > 0 ? parseCodePath(tail.join('/')) : undefined;
    return code && 'rest' in code && code.kind === undefined ? classicCodePath(owner, repo, tail, ctx) : path || '/';
  }
  const [, , a, ...rest] = segs;
  if (a === undefined || a === 'callback') return '/';
  if (a === 'code') {
    const [owner = '', repo = '', ...tail] = rest;
    return classicCodePath(owner, repo, legacyCodeSplat(tail.join('/')).split('/').filter(Boolean), ctx);
  }
  if (a === 'projects') {
    const id = Number(rest[0]);
    const place = Number.isSafeInteger(id) ? ctx.board?.(id) : undefined;
    if (place?.repo) return `/${place.repo.split('/').map(enc).join('/')}/projects/${String(id)}`;
    if (place?.owner) return `/${enc(place.owner)}/-/projects/${String(id)}`;
    return ctx.login ? `/${enc(ctx.login)}/-/projects` : '/';
  }
  if (a === 'boards') return ctx.login ? `/${enc(ctx.login)}/-/projects` : '/';
  return `/${[a, ...rest].map(enc).join('/')}`;
}

/** Ref-less code routes mean the default branch here but 404 in classic; use its branch or repository home. */
function classicCodePath(owner: string, repo: string, tail: string[], ctx: ClassicContext): string {
  const [view, kind] = tail;
  if ((view === 'src' || view === 'commits' || view === 'blame') && kind !== 'branch' && kind !== 'tag' && kind !== 'commit') {
    const branch = ctx.defaultBranch?.(owner, repo);
    if (!branch) return `/${enc(owner)}/${enc(repo)}`;
    tail = [view, 'branch', ...branch.split('/'), ...tail.slice(1)];
  }
  return `/${[owner, repo, ...tail].map(enc).join('/')}`;
}

/** Keeps queries for canonical routes; app-only routes map shapes and drop their queries. */
export function classicOfLocation(path: string, search: string, ctx: ClassicContext = {}): string {
  const mapped = classicPathOf(path, ctx);
  const params = new URLSearchParams(search.replace(/^\?/, ''));
  // Classic uses a path for PR tabs and has no Checks page.
  const tab = params.get('tab');
  if (tab !== null && /\/pulls\/[1-9]\d*$/.test(mapped)) {
    params.delete('tab');
    const q = params.toString();
    return `${mapped}${tab === 'files' || tab === 'commits' ? `/${tab}` : ''}${q ? `?${q}` : ''}`;
  }
  const q = search.replace(/^\?/, '');
  return mapped === (path || '/') && q ? `${mapped}?${q}` : mapped;
}

/** Returns the repository for a page readable without signing in when the repository is public. */
export function publicPageRepo(classic: string): {owner: string; repo: string} | undefined {
  if (/%(?:2e|2f|5c)/i.test(classic)) return undefined;
  const at = classic.search(/[?#]/);
  const [owner = '', repo = '', c, ...rest] = segments(at < 0 ? classic : classic.slice(0, at));
  if (!isOwnerName(owner) || !NAME.test(repo)) return undefined;
  if (c === undefined) return {owner, repo};
  if ((c === 'issues' || c === 'pulls') && rest.length === 1 && /^[1-9]\d{0,15}$/.test(rest[0] ?? '')) return {owner, repo};
  const code = parseCodePath([c, ...rest].join('/'));
  return code && code.view !== 'release-form' ? {owner, repo} : undefined;
}

/** Matches canonical routes served by the backend. */
export function isCanonical(path: string, search = ''): boolean {
  return isSpaRoute(path, search);
}

/** Lists an issue may return to via Esc. */
export function isListPath(path: string): boolean {
  const segs = segments(path);
  if (segs.length === 1) return segs[0] === 'notifications' || segs[0] === 'issues' || segs[0] === 'pulls';
  if (segs[0] === '-') return segs[1] === 'next' && (segs[2] === 'boards' || (segs[2] === 'projects' && segs.length === 4));
  if (segs.length === 4 && segs[2] === 'milestone') return isOwnerName(segs[0] ?? '') && /^[1-9]\d{0,15}$/.test(segs[3] ?? '');
  return segs.length === 3 && isOwnerName(segs[0] ?? '') && (segs[2] === 'issues' || segs[2] === 'pulls');
}

export const ISSUE_SECTIONS: ReadonlySet<string> = new Set(['labels', 'milestones', 'milestone']);

/** Returns the route's repository as lower-case owner/name, if any. */
export function repoOfPath(path: string): string | undefined {
  const segs = segments(path);
  if (segs[0] === '-') {
    if (segs[1] === 'next' && segs[2] === 'code' && segs[3] && segs[4]) return `${segs[3]}/${segs[4]}`.toLowerCase();
    return undefined;
  }
  const [a = '', b = '', c] = segs;
  if (segs.length < 2 || !isOwnerName(a) || !NAME.test(b)) return undefined;
  if (c !== undefined && c !== 'issues' && c !== 'pulls' && c !== 'activity' && c !== 'wiki' && c !== 'settings' && c !== 'watchers' && !ISSUE_SECTIONS.has(c) &&
    !parseCodePath(segs.slice(2).join('/'))) return undefined;
  return `${a}/${b}`.toLowerCase();
}
