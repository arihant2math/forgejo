// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Route table and code splitting. Every route is its own lazy chunk; the boot
// route's chunk is modulepreloaded from index.html (vite.config.ts bootRoutes)
// so it loads in parallel with the entry instead of after it.
// F3 replaces this with TanStack Router; keep each route a lazy import there too.

import {lazy} from 'react';

export const BASE = import.meta.env.BASE_URL; // "/-/next/"

const Home = lazy(() => import('../features/home/Home.tsx'));
// Dev-only: `import.meta.env.DEV` is false in production builds, so the
// gallery and its chunk are not part of the shipped app.
const Gallery = import.meta.env.DEV ? lazy(() => import('../features/gallery/Gallery.tsx')) : undefined;

export function RouteView({pathname}: {pathname: string}) {
  const path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\//, '');
  if (Gallery && path === 'gallery') return <Gallery/>;
  return <Home/>;
}
