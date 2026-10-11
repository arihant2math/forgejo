// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The router's canonical routes are exactly the server's `spaRoutes`
// (routers/livesync/spa.go, B8): a route the server does not list would
// reload into the classic UI, and one the router does not know would show
// "not found" for a URL the server sent the app for.

import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createMemoryHistory} from '@tanstack/react-router';
import {expect, test} from 'vitest';
import {fallbackConfig} from './config.ts';
import {createAppRouter} from './router.tsx';
import {createApp} from './store.ts';

const spa = readFileSync(resolve(process.cwd(), '../routers/livesync/spa.go'), 'utf8');

function serverRoutes(): string[] {
  const start = spa.indexOf('var spaRoutes = [][]string{');
  const end = spa.indexOf('\n}', start);
  expect(start).toBeGreaterThan(0);
  // `{temp}` (an issue created offline, "new-<uuid>") is the issue route's `$index` too (IssueView reads both).
  return [...new Set([...spa.slice(start, end).matchAll(/^\s*\{(.*)\},/gm)].map((m) =>
    `/${[...(m[1] ?? '').matchAll(/"([^"]+)"/g)].map((s) => (s[1] ?? '').replace(/^\{(\w+)\}$/, (_, p: string) => `$${p === 'temp' ? 'index' : p}`)).join('/')}`))];
}

function router() {
  return createAppRouter(createApp(fallbackConfig(), undefined), createMemoryHistory());
}

function canonicalRoutes(): string[] {
  return Object.values(router().routesById)
    .map((r) => r.fullPath)
    .filter((p: string) => p !== '' && p !== '/$' && !p.startsWith('/-/next') && !p.startsWith('/__'));
}

test('every server spaRoute is a route of the app', () => {
  // `{code}` (a repository's code address) is the shell's catch-all, which redirects to the code view (below).
  const routes = serverRoutes().filter((r) => !r.endsWith('/$code'));
  expect(routes).toContain('/');
  expect(routes).toContain('/$owner/$repo/issues/$index');
  const mine = new Set(canonicalRoutes());
  for (const r of routes) expect(mine.has(r), r).toBe(true);
});

test('every canonical route of the app is a server spaRoute', () => {
  const server = new Set(serverRoutes());
  for (const r of canonicalRoutes()) expect(server.has(r), r).toBe(true);
});

test('sample URLs match a page (not the root\'s not-found)', () => {
  const r = router();
  for (const path of ['/', '/notifications', '/issues', '/pulls', '/acme/web.site', '/-/next/acme', '/-/next/acme/web.site', '/-/next/acme/web.site/', '/acme/web.site/issues', '/acme/web.site/issues/12', '/acme/api/pulls/3', '/-/next/', '/-/next/callback', '/acme/web.site/wiki', '/acme/web.site/wiki/', '/acme/web.site/wiki/Home', '/acme/web.site/wiki/-/pages', '/acme/web.site/wiki/-/new', '/acme/web.site/wiki/Home/-/edit',
    '/acme/api/labels', '/acme/api/milestones', '/acme/api/milestones/new', '/acme/api/milestone/4', '/acme/api/milestone/4/edit', '/repo/create', '/org/create',
    '/user/settings', '/user/settings/keys', '/user/settings/account', '/user/settings/appearance']) {
    const matches = r.matchRoutes(path, {});
    const leaf = matches.at(-1);
    expect(leaf?.routeId, path).not.toBe('__root__');
    expect((leaf as {globalNotFound?: boolean} | undefined)?.globalNotFound ?? false, path).toBe(false);
  }
});

test('the new repository and organization forms are their own pages, never an owner\'s repository', () => {
  const r = router();
  const leaf = (path: string) => r.matchRoutes(path, {}).at(-1) as {fullPath?: string} | undefined;
  expect(leaf('/repo/create')?.fullPath).toBe('/repo/create');
  expect(leaf('/org/create')?.fullPath).toBe('/org/create');
  // A repository named "create" is still one.
  expect(leaf('/acme/create')?.fullPath).toBe('/$owner/$repo');
});

test('wiki addresses: the views by their own routes, page names decoded', () => {
  const r = router();
  const leaf = (path: string) => r.matchRoutes(path, {}).at(-1);
  expect(leaf('/acme/atlas/wiki')?.routeId).toBe('/shell/$owner/$repo/wiki');
  expect(leaf('/acme/atlas/wiki/-/pages')?.routeId).toBe('/shell/$owner/$repo/wiki/-/pages');
  expect(leaf('/acme/atlas/wiki/-/new')?.routeId).toBe('/shell/$owner/$repo/wiki/-/new');
  expect(leaf('/acme/atlas/wiki/Home/-/edit')?.routeId).toBe('/shell/$owner/$repo/wiki/$page/-/edit');
  const page = leaf('/acme/atlas/wiki/C%2B%2B');
  expect(page?.routeId).toBe('/shell/$owner/$repo/wiki/$page');
  expect((page?.params as {page?: string} | undefined)?.page).toBe('C++');
});

test('no source string is exactly the base: B8 rewrites those under a sub-path (only import.meta.env.BASE_URL may be)', async () => {
  const {readdirSync} = await import('node:fs');
  const files = readdirSync(resolve(process.cwd(), 'src'), {recursive: true, encoding: 'utf8'})
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.startsWith('test/') && !f.startsWith('dev/') && !f.startsWith('protocol/'));
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(resolve(process.cwd(), 'src', f), 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '');
    if (/(['"`])\/-\/next\/\1/.test(src)) bad.push(f);
  }
  expect(bad).toEqual([]);
});

test('the server preloads the views the router loads (spa_preload.go routeModules names router.tsx\'s lazy views)', () => {
  const go = readFileSync(resolve(process.cwd(), '../routers/livesync/spa_preload.go'), 'utf8');
  const named = [...new Set([...go.matchAll(/"src\/(features\/[\w/]+\.tsx)"/g)].map((m) => m[1] ?? ''))];
  expect(named.length).toBeGreaterThan(8);
  const router = readFileSync(resolve(process.cwd(), 'src/app/router.tsx'), 'utf8');
  const home = readFileSync(resolve(process.cwd(), 'src/features/home/Home.tsx'), 'utf8');
  for (const m of named) {
    const lazy = router.includes(`import('../${m}')`) || home.includes(`import('./${m.split('/').at(-1) ?? ''}')`);
    expect(lazy, m).toBe(true);
  }
});

test('a repository page\'s skeleton has its header\'s rows (RepoHeader): breadcrumb, tabs, title row', () => {
  const routes = Object.values(router().routesById).filter((r) => r.options.staticData?.skeleton !== undefined);
  const repoPages = routes.filter((r) => r.fullPath.startsWith('/$owner/$repo') || r.fullPath.startsWith('/-/next/code/'));
  expect(repoPages.length).toBeGreaterThan(6);
  for (const r of repoPages) {
    const header = r.options.staticData?.header;
    // The home has no title row; an issue's or a pull request's page has no repository tabs (one row).
    if (r.fullPath === '/$owner/$repo') expect(header, r.fullPath).toBe('tabs');
    else if (/\/(issues|pulls)\/\$index$/.test(r.fullPath)) expect(header, r.fullPath).toBeUndefined();
    else expect(header, r.fullPath).toBe('toolbar');
  }
  // Every page outside a repository: one row.
  for (const r of routes.filter((x) => !repoPages.includes(x))) expect(r.options.staticData?.header, r.fullPath).toBeUndefined();
});

test('the settings pages are their own routes, never an owner\'s repository (`user` is reserved)', () => {
  const r = router();
  const leaf = (path: string) => r.matchRoutes(path, {}).at(-1)?.routeId;
  expect(leaf('/user/settings')).toBe('/shell/user/settings');
  expect(leaf('/user/settings/')).toBe('/shell/user/settings');
  expect(leaf('/user/settings/account')).toBe('/shell/user/settings/account');
  expect(leaf('/user/settings/appearance')).toBe('/shell/user/settings/appearance');
  expect(leaf('/user/settings/keys')).toBe('/shell/user/settings/keys');
  // A classic settings page is no repository page of an owner "user" (the shell's not-found, with the classic page).
  expect(leaf('/user/settings/applications')).toBe('/shell/$');
  expect(leaf('/acme/settings')).toBe('/shell/$owner/$repo');
});
