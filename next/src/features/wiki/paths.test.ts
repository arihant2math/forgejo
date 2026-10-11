// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {expect, test} from 'vitest';
import {
  classicWikiPath, decodeContent, encodeContent, listOrder, pageOfSubUrl, pageTitle, parseWikiRest, revisionsPath, wikiActionView,
  wikiPageOfPath, wikiPath,
} from './paths.ts';

test('the views a wiki address names', () => {
  expect(parseWikiRest([])).toEqual({view: 'page', page: 'Home'});
  expect(parseWikiRest(['Getting-Started'])).toEqual({view: 'page', page: 'Getting-Started'});
  expect(parseWikiRest(['-'])).toEqual({view: 'page', page: '-'});
  expect(parseWikiRest(['-', 'pages'])).toEqual({view: 'pages'});
  expect(parseWikiRest(['-', 'new'])).toEqual({view: 'new'});
  expect(parseWikiRest(['Home', '-', 'edit'])).toEqual({view: 'edit', page: 'Home'});
  // The classic wiki's own routes and Forgejo's reserved names are no page; deeper addresses are classic.
  for (const rest of [['raw'], ['search'], ['_pages'], ['_new'], ['_edit'], ['..'], ['.'], ['raw', 'logo.png'], ['commit', 'abc1234'], ['-', 'history'], ['raw', '-', 'edit'], ['a', 'b', 'c', 'd'], ['a/b']]) {
    expect(parseWikiRest(rest), rest.join('/')).toBeUndefined();
  }
});

test('the classic wiki\'s ?action= opens the same view here', () => {
  const home = {view: 'page', page: 'Home'} as const;
  expect(wikiActionView(home, '_pages')).toEqual({view: 'pages'});
  expect(wikiActionView(home, '_new')).toEqual({view: 'new'});
  expect(wikiActionView({view: 'page', page: 'X'}, '_edit')).toEqual({view: 'edit', page: 'X'});
  expect(wikiActionView(home, '_revision')).toBe(home);
  expect(wikiActionView(home, undefined)).toBe(home);
  expect(wikiActionView({view: 'pages'}, '_edit')).toEqual({view: 'pages'});
});

test('app addresses and their classic pages', () => {
  expect(wikiPath('acme', 'atlas', {view: 'page', page: 'C++'})).toBe('/acme/atlas/wiki/C%2B%2B');
  expect(wikiPath('acme', 'atlas', {view: 'pages'})).toBe('/acme/atlas/wiki/-/pages');
  expect(wikiPath('acme', 'atlas', {view: 'new'})).toBe('/acme/atlas/wiki/-/new');
  expect(wikiPath('acme', 'atlas', {view: 'edit', page: 'Home'})).toBe('/acme/atlas/wiki/Home/-/edit');
  expect(classicWikiPath('acme', 'atlas', {view: 'page', page: 'Home'})).toBe('/acme/atlas/wiki/Home');
  expect(classicWikiPath('acme', 'atlas', {view: 'pages'})).toBe('/acme/atlas/wiki/?action=_pages');
  expect(classicWikiPath('acme', 'atlas', {view: 'new'})).toBe('/acme/atlas/wiki/?action=_new');
  expect(classicWikiPath('acme', 'atlas', {view: 'edit', page: 'Foo-Bar.-'})).toBe('/acme/atlas/wiki/Foo-Bar.-?action=_edit');
  expect(revisionsPath('acme', 'atlas', 'Home')).toBe('/acme/atlas/wiki/Home?action=_revision');
});

test('links resolve to a page of this wiki (as Forgejo renders them), anything else is no page', () => {
  expect(wikiPageOfPath('/acme/atlas/wiki/Other-Page', 'acme', 'atlas')).toBe('Other-Page');
  expect(wikiPageOfPath('/ACME/Atlas/wiki/Other-Page#part', 'acme', 'atlas')).toBe('Other-Page');
  expect(wikiPageOfPath('/acme/atlas/wiki', 'acme', 'atlas')).toBe('Home');
  expect(wikiPageOfPath('/acme/atlas/wiki/C%2B%2B?x=1', 'acme', 'atlas')).toBe('C++');
  for (const p of ['/acme/atlas/wiki/raw/logo.png', '/acme/other/wiki/Home', '/acme/atlas/src/branch/main/x.md', '/acme/atlas/wiki/-/pages', '/acme/atlas/wiki/a%2Fb', '/acme/atlas/wiki/Home/-/edit']) {
    expect(wikiPageOfPath(p, 'acme', 'atlas'), p).toBeUndefined();
  }
});

test('titles from page names (services/wiki WebPathToUserTitle)', () => {
  expect(pageTitle('Home')).toBe('Home');
  expect(pageTitle('Getting-Started')).toBe('Getting Started');
  expect(pageTitle('Foo-Bar.-')).toBe('Foo-Bar');
  expect(pageTitle('C++')).toBe('C++');
  expect(pageTitle(pageOfSubUrl('C%2B%2B'))).toBe('C++');
  expect(pageTitle(pageOfSubUrl('100%25-sure'))).toBe('100% sure');
  expect(pageOfSubUrl('Caf%C3%A9')).toBe('Café');
  expect(pageOfSubUrl('%zz')).toBe('%zz');
});

test('the page list: Home first, natural order, no sidebar or footer', () => {
  const p = (name: string, title = name) => ({name, title});
  expect(listOrder([p('Step-10', 'Step 10'), p('_Sidebar'), p('Step-2', 'Step 2'), p('Home'), p('about', 'about'), p('_Footer')]).map((x) => x.name))
    .toEqual(['Home', 'about', 'Step-2', 'Step-10']);
});

test('content travels as base64 of UTF-8', () => {
  for (const text of ['', '# Hello', 'Grüße — 日本語 🎉\n\n```go\nfunc main() {}\n```', 'x'.repeat(100_000)]) {
    expect(decodeContent(encodeContent(text))).toBe(text);
  }
  expect(encodeContent('é')).toBe('w6k=');
  expect(decodeContent('w6k=')).toBe('é');
  expect(decodeContent(undefined)).toBe('');
});
