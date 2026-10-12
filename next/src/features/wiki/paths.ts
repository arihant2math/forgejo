// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Page names are decoded web paths; encode links with encodeURIComponent to match Forgejo normalization.
// Clean editor/list routes coexist with classic ?action routes; revisions remain classic-only.

export const HOME = 'Home';

/** Sidebar and footer pages are rendered around content, not listed as ordinary pages. */
export const SIDEBAR = '_Sidebar';
export const FOOTER = '_Footer';

/** Reserved segments name no page; keep in sync with spa.go wikiReserved. */
export const WIKI_RESERVED: ReadonlySet<string> = new Set(['raw', 'search', '_pages', '_new', '_edit']);

export type WikiView =
  | {view: 'page'; page: string}
  | {view: 'pages'}
  | {view: 'new'}
  | {view: 'edit'; page: string};

export function isPageSegment(s: string): boolean {
  return s !== '' && s !== '.' && s !== '..' && !WIKI_RESERVED.has(s) && !s.includes('/');
}

/** Input segments are decoded; undefined denotes a classic-only address. */
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

/** Map classic _pages/_new/_edit actions; leave other actions unchanged. */
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

export function wikiBase(owner: string, repo: string): string {
  return `/${enc(owner)}/${enc(repo)}/wiki`;
}

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

/** Only same-repository wiki pages qualify; compare owner/repo case-insensitively like Forgejo. */
export function wikiPageOfPath(path: string, owner: string, repo: string): string | undefined {
  if (/%(?:2e|2f|5c)/i.test(path)) return undefined;
  const segs = path.split(/[?#]/)[0]?.split('/').filter((s) => s !== '').map(decode) ?? [];
  const [a = '', b = '', c, ...rest] = segs;
  if (c !== 'wiki' || a.toLowerCase() !== owner.toLowerCase() || b.toLowerCase() !== repo.toLowerCase()) return undefined;
  const v = parseWikiRest(rest);
  return v?.view === 'page' ? v.page : undefined;
}

/** Match Go QueryUnescape: + means space; malformed input is returned unchanged. */
function queryUnescape(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Match Forgejo WebPathToUserTitle, including its .- marker for literal dashes. */
export function pageTitle(page: string): string {
  let s = enc(page.slice(page.lastIndexOf('/') + 1));
  if (s.endsWith('.md')) s = decode(s.slice(0, -3));
  if (s.endsWith('.-')) return queryUnescape(s.slice(0, -2));
  return queryUnescape(s.replace(/-/g, ' '));
}

/** Decode API v1's sub_url to a web-path page name. */
export function pageOfSubUrl(subUrl: string): string {
  return decode(subUrl);
}

export interface WikiListed {
  name: string;
  title: string;
}

/** Home first, then natural title order; exclude sidebar and footer. */
export function listOrder<T extends WikiListed>(pages: readonly T[]): T[] {
  const coll = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
  return pages.filter((p) => p.name !== SIDEBAR && p.name !== FOOTER)
    .sort((x, y) => Number(y.name === HOME) - Number(x.name === HOME) || coll.compare(x.title, y.title) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/** Encode UTF-8 text as API v1 wiki base64 content. */
export function encodeContent(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Decode API v1 wiki content; absent content means empty text. */
export function decodeContent(b64: string | null | undefined): string {
  if (!b64) return '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
