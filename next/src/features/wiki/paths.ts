// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// A repository's wiki addresses (pure; paths.test.ts). The app renders the
// wiki on Forgejo's own URLs — `/{owner}/{repo}/wiki` (its Home) and
// `/{owner}/{repo}/wiki/{page}` — plus clean addresses for what the classic
// wiki puts in a query: the page list (`/wiki/-/pages`, classic
// `?action=_pages`), a new page (`/wiki/-/new`, `?action=_new`) and a
// page's editor (`/wiki/{page}/-/edit`, `?action=_edit`). The classic
// addresses keep working: the server serves the app for them and the route
// goes on to the clean one (wikiActionView). A page's revisions stay
// classic (`?action=_revision`: routers/livesync/spa.go wikiClassic).
//
// A page is named here by its web path as the URL carries it, decoded (the
// route's param): "Getting-Started", "C++" (Forgejo writes "C%2B%2B"). Any
// encoding of it names the same page (Forgejo unescapes and escapes it again:
// services/wiki/wiki_path.go WebPathToGitPath), so the app's links encode it
// with encodeURIComponent.

/** The page the wiki opens on. */
export const HOME = 'Home';

/** The wiki's special pages: shown around every page (classic and GitHub), not listed with the others. */
export const SIDEBAR = '_Sidebar';
export const FOOTER = '_Footer';

/**
 * Segments after `/wiki/` that name no page: the classic wiki's own routes (raw files, search) and the names
 * Forgejo reserves (services/wiki reservedWikiNames). Keep in step with spa.go wikiReserved.
 */
export const WIKI_RESERVED: ReadonlySet<string> = new Set(['raw', 'search', '_pages', '_new', '_edit']);

export type WikiView =
  | {view: 'page'; page: string}
  | {view: 'pages'}
  | {view: 'new'}
  | {view: 'edit'; page: string};

/** Whether a (decoded) segment can be a page's address. */
export function isPageSegment(s: string): boolean {
  return s !== '' && s !== '.' && s !== '..' && !WIKI_RESERVED.has(s) && !s.includes('/');
}

/** The view what follows `/{owner}/{repo}/wiki` names (decoded segments), or undefined (a classic-only address). */
export function parseWikiRest(rest: readonly string[]): WikiView | undefined {
  const [a = '', b, c] = rest;
  switch (rest.length) {
    case 0:
      return {view: 'page', page: HOME};
    case 1:
      return isPageSegment(a) ? {view: 'page', page: a} : undefined;
    case 2:
      return a === '-' && (b === 'pages' || b === 'new') ? {view: b} : undefined;
    case 3:
      return b === '-' && c === 'edit' && isPageSegment(a) ? {view: 'edit', page: a} : undefined;
  }
  return undefined;
}

/** The view the classic wiki's `?action=` asks for on an address (`_pages`, `_new`, `_edit`); other actions change nothing. */
export function wikiActionView(v: WikiView, action: string | undefined): WikiView {
  if (v.view !== 'page') return v;
  switch (action) {
    case '_pages':
      return {view: 'pages'};
    case '_new':
      return {view: 'new'};
    case '_edit':
      return {view: 'edit', page: v.page};
  }
  return v;
}

const enc = (s: string) => encodeURIComponent(s);

/** The wiki's address (its Home). */
export function wikiBase(owner: string, repo: string): string {
  return `/${enc(owner)}/${enc(repo)}/wiki`;
}

/** The app's address of a wiki view (a site path). */
export function wikiPath(owner: string, repo: string, v: WikiView): string {
  const base = wikiBase(owner, repo);
  switch (v.view) {
    case 'page':
      return `${base}/${enc(v.page)}`;
    case 'pages':
      return `${base}/-/pages`;
    case 'new':
      return `${base}/-/new`;
    case 'edit':
      return `${base}/${enc(v.page)}/-/edit`;
  }
}

/** The classic page of a wiki view ("Open in the classic UI"). */
export function classicWikiPath(owner: string, repo: string, v: WikiView): string {
  const base = wikiBase(owner, repo);
  switch (v.view) {
    case 'page':
      return `${base}/${enc(v.page)}`;
    case 'pages':
      return `${base}/?action=_pages`;
    case 'new':
      return `${base}/?action=_new`;
    case 'edit':
      return `${base}/${enc(v.page)}?action=_edit`;
  }
}

/** A page's revisions (the classic wiki's: the app has no history view of its own). */
export function revisionsPath(owner: string, repo: string, page: string): string {
  return `${wikiBase(owner, repo)}/${enc(page)}?action=_revision`;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The wiki page a link points at in the wiki of owner/repo (a site path, as Forgejo renders a wiki's links:
 * `/{owner}/{repo}/wiki/{page}`), or undefined: another repository's, a raw file, anything else. Names compare
 * case-insensitively (as the router's repository lookup does).
 */
export function wikiPageOfPath(path: string, owner: string, repo: string): string | undefined {
  if (/%(?:2e|2f|5c)/i.test(path)) return undefined;
  const segs = path.split(/[?#]/)[0]?.split('/').filter((s) => s !== '').map(decode) ?? [];
  const [a = '', b = '', c, ...rest] = segs;
  if (c !== 'wiki' || a.toLowerCase() !== owner.toLowerCase() || b.toLowerCase() !== repo.toLowerCase()) return undefined;
  const v = parseWikiRest(rest);
  return v?.view === 'page' ? v.page : undefined;
}

/** The query-unescaping of Go's url.QueryUnescape ("+" is a space); the text as is when it is not valid. */
function queryUnescape(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/**
 * A page's title from its name (services/wiki WebPathToUserTitle): "Getting-Started" → "Getting Started",
 * "Foo-Bar.-" (a title with a dash, marked) → "Foo-Bar", "C++" → "C++".
 */
export function pageTitle(page: string): string {
  // The web path as Forgejo writes it (the name here is decoded).
  let s = enc(page.slice(page.lastIndexOf('/') + 1));
  if (s.endsWith('.md')) s = decode(s.slice(0, -3));
  if (s.endsWith('.-')) return queryUnescape(s.slice(0, -2));
  return queryUnescape(s.replace(/-/g, ' '));
}

/** A page's name (decoded web path) from the web path Forgejo lists it with (API v1 sub_url). */
export function pageOfSubUrl(subUrl: string): string {
  return decode(subUrl);
}

export interface WikiListed {
  name: string;
  title: string;
}

/**
 * The pages a wiki lists, in the order it shows them: Home first, then by title in natural order (as the classic
 * page list: "Step 2" before "Step 10"), without the sidebar and the footer.
 */
export function listOrder<T extends WikiListed>(pages: readonly T[]): T[] {
  const coll = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
  return pages.filter((p) => p.name !== SIDEBAR && p.name !== FOOTER)
    .sort((x, y) => Number(y.name === HOME) - Number(x.name === HOME) || coll.compare(x.title, y.title) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/** A text as API v1's wiki endpoints carry it (base64 of its UTF-8). */
export function encodeContent(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The text of API v1's base64 content ("" for none). */
export function decodeContent(b64: string | null | undefined): string {
  if (!b64) return '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
