// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Route table and code splitting: every route is its own chunk.
//
// The boot route is never rendered through Suspense: main.tsx awaits its
// module before the first render, because React holds a Suspense reveal for
// up to 300 ms after showing a fallback (that would break the warm-boot
// budget). Its chunk is modulepreloaded from index.html (tools/boot.ts), so
// the await costs nothing. F3 replaces this with TanStack Router, keeping both
// rules: lazy route chunks, and `await router.load()` before the first render.

import type {ComponentType} from 'react';

export interface RouteModule {
  default: ComponentType;
}

export const BASE = import.meta.env.BASE_URL; // "/-/next/"

const home = () => import('../features/home/Home.tsx');
const routes: Record<string, () => Promise<RouteModule>> = {'': home};
// Dev-only: `import.meta.env.DEV` is false in production builds, so the gallery
// and its chunk are not part of the shipped app.
if (import.meta.env.DEV) routes.gallery = () => import('../dev/gallery/Gallery.tsx');

export function loadRoute(pathname: string): Promise<RouteModule> {
  const path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\//, '');
  return (routes[path.replace(/\/$/, '')] ?? home)();
}
