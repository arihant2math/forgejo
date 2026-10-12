// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {BOOT_ROUTES} from './tools/boot.ts';
import {previewConfig} from './tools/vite-plugin-preview-config.ts';
import {primerLayer} from './tools/vite-plugin-primer-layer.ts';
import {shell} from './tools/vite-plugin-shell.ts';
import {serviceWorker} from './tools/vite-plugin-sw.ts';

/**
 * Per-package vendor chunks (PLAN §1): a dependency update only invalidates its
 * own chunk, and a package only one lazy route uses loads with that route.
 * Icons share one chunk rather than issuing a request per glyph.
 */
export function vendorChunk(id: string): string | null {
  const m = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id);
  if (!m?.[1]) return null;
  const pkg = m[1].replace('\\', '/');
  // React's profiling build (localStorage.profile, app/profile.tsx) loads only when asked: never with react-dom.
  if (pkg === 'react-dom' && id.includes('profiling')) return 'vendor-react-dom-profiling';
  // Primer's components: one chunk (and one stylesheet), so that boot routes' components never bring a late
  // stylesheet of their own.
  if (pkg === '@primer/react') return 'vendor-primer-react';
  return `vendor-${pkg.replace(/^@/, '').replace('/', '-')}`;
}

export default defineConfig({
  // Same origin as Forgejo; B8 serves dist/ under /-/next/ (PLAN §4.10).
  base: '/-/next/',
  plugins: [
    react(),
    primerLayer(),
    tailwindcss(),
    shell({bootRoutes: BOOT_ROUTES}),
    serviceWorker(),
    previewConfig(),
  ],
  css: {
    transformer: 'lightningcss',
  },
  // Module workers (they are started with {type: 'module'}): the code worker's Shiki grammars are
  // dynamic imports, one lazy chunk each (an IIFE worker would inline all of them).
  worker: {
    format: 'es',
    // Grammar chunks are named lang-*: the service worker caches them on first use instead of at install
    // (≈ 3 MB: precaching them held up the offline install of everything else; tools/vite-plugin-sw.ts).
    rolldownOptions: {
      output: {
        chunkFileNames: (c) => (c.moduleIds.length > 0 && c.moduleIds.every((id) => id.includes('/@shikijs/langs/')) ? 'assets/lang-[name]-[hash].js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  build: {
    target: 'esnext',
    cssTarget: 'esnext',
    cssMinify: 'lightningcss',
    manifest: true,
    // Maps are written for debugging but not referenced from the chunks (and
    // must not be precached or served by default).
    sourcemap: 'hidden',
    modulePreload: {polyfill: false},
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Without this, a group also captures its dependencies, e.g. react
          // would land in vendor-primer-octicons-react. Vendor packages here are either
          // side-effect free ESM or lazily initialised CJS wrappers, so splitting
          // them apart cannot reorder side effects (the e2e boot test runs the build).
          includeDependenciesRecursively: false,
          groups: [
            {name: vendorChunk, debugName: 'vendor'},
            // Only static entry dependencies: lazy views stay lazy. Include
            // Vite's preload helper so it cannot form a cycle through the entry.
            {name: 'app-boot', test: (id) => (/[\\/]src[\\/]/.test(id) && !id.endsWith('/src/main.tsx')) || id.includes('vite/preload-helper'), tags: ['$initial']},
          ],
        },
      },
    },
  },
  // Primer's modules import their stylesheets: Vite (not Node) loads them when a module is rendered on the server
  // (the boot shell, tools/vite-plugin-shell.ts).
  ssr: {noExternal: [/@primer\/react/]},
  server: {
    port: 5173,
    strictPort: true,
    // With NEXT_FORGEJO_URL (a dev Forgejo, next/tools/dev-forgejo.sh), every
    // path outside the UI's base — and the UI's server-side endpoints below
    // it — goes to Forgejo: API, sync socket, classic login and consent
    // pages. Sign-in then needs this origin's callback registered:
    // [livesync] OAUTH_REDIRECT_URIS = http://127.0.0.1/-/next/callback.
    ...(process.env.NEXT_FORGEJO_URL ? {
      proxy: {
        '^/(?!-/next/(?!config$|opt-in|opt-out)).*': {target: process.env.NEXT_FORGEJO_URL, ws: true, changeOrigin: false},
      },
    } : {}),
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
