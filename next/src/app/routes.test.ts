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
  return [...spa.slice(start, end).matchAll(/^\s*\{(.*)\},/gm)].map((m) =>
    `/${[...(m[1] ?? '').matchAll(/"([^"]+)"/g)].map((s) => (s[1] ?? '').replace(/^\{(\w+)\}$/, (_, p: string) => `$${p === 'index' ? 'index' : p}`)).join('/')}`);
}

function router() {
  return createAppRouter(createApp(fallbackConfig(), undefined), createMemoryHistory());
}

function canonicalRoutes(): string[] {
  return Object.values(router().routesById)
    .map((r) => r.fullPath)
    .filter((p: string) => p !== '' && !p.startsWith('/-/next') && !p.startsWith('/__'));
}

test('every server spaRoute is a route of the app', () => {
  const routes = serverRoutes();
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
  for (const path of ['/', '/notifications', '/issues', '/pulls', '/acme/web.site/issues', '/acme/web.site/issues/12', '/acme/api/pulls/3', '/-/next/', '/-/next/callback']) {
    const matches = r.matchRoutes(path, {});
    const leaf = matches.at(-1);
    expect(leaf?.routeId, path).not.toBe('__root__');
    expect((leaf as {globalNotFound?: boolean} | undefined)?.globalNotFound ?? false, path).toBe(false);
  }
});
