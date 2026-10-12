// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import type {PreRenderedChunk} from 'rolldown';
import {defineConfig} from 'vite';
import {BOOT_ROUTES} from './tools/boot.ts';
import {dropAutoColorMode} from './tools/lightningcss-color-mode.ts';
import {previewConfig} from './tools/vite-plugin-preview-config.ts';
import {primerLayer} from './tools/vite-plugin-primer-layer.ts';
import {shell} from './tools/vite-plugin-shell.ts';
import {serviceWorker} from './tools/vite-plugin-sw.ts';

/** Split by package so updates invalidate only that chunk and lazy-route dependencies stay lazy. */
export function vendorChunk(id: string): string | null {
  const m = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id);
  if (!m?.[1]) return null;
  const pkg = m[1].replace('\\', '/');
  // Grammars and themes are loaded one dynamic import at a time.
  if (pkg === '@shikijs/langs' || pkg === '@shikijs/themes' || pkg === '@pierre/theme') return null;
  // Split into boot and lazy halves by the groups below.
  if (pkg === '@primer/react' || pkg === '@primer/octicons-react') return null;
  // React's profiling build (localStorage.profile, app/profile.tsx) loads only when asked: never with react-dom.
  if (pkg === 'react-dom' && id.includes('profiling')) return 'vendor-react-dom-profiling';
  return `vendor-${pkg.replace(/^@/, '').replace('/', '-')}`;
}

/** Prefixes grammar and theme chunks so the service worker caches them on first use (`ON_DEMAND`). */
export function chunkFileNames(c: PreRenderedChunk): string {
  const all = (re: RegExp) => c.moduleIds.length > 0 && c.moduleIds.every((id) => re.test(id));
  if (all(/[\\/]@shikijs[\\/]langs[\\/]/)) return 'assets/lang-[name]-[hash].js';
  if (all(/[\\/]@shikijs[\\/]themes[\\/]|[\\/]@pierre[\\/]theme[\\/]/)) return 'assets/theme-[name]-[hash].js';
  return 'assets/[name]-[hash].js';
}

export default defineConfig({
  base: '/-/next/',
  plugins: [
    react(),
    primerLayer(),
    tailwindcss(),
    shell({bootRoutes: BOOT_ROUTES}),
    serviceWorker(),
    previewConfig(),
  ],
  resolve: {alias: {'shiki/wasm': fileURLToPath(new URL('tools/no-wasm.ts', import.meta.url))}},
  css: {
    transformer: 'lightningcss',
    lightningcss: {visitor: dropAutoColorMode},
  },
  // Module workers keep Shiki grammars as lazy imports; IIFE workers would inline them all.
  worker: {
    format: 'es',
    rolldownOptions: {output: {chunkFileNames}},
  },
  build: {
    target: 'esnext',
    cssTarget: 'esnext',
    cssMinify: 'lightningcss',
    manifest: true,
    // Hidden sourcemaps aid debugging without being referenced, precached or served by default.
    sourcemap: 'hidden',
    modulePreload: {polyfill: false},
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        chunkFileNames,
        codeSplitting: {
          // Do not capture dependencies into unrelated vendor groups; split only side-effect-free or lazy wrappers.
          includeDependenciesRecursively: false,
          groups: [
            {name: vendorChunk, debugName: 'vendor'},
            // What the entry imports statically ships at boot, its stylesheet linked from the page; the rest loads with
            // the first lazy view that needs it (Vite's preload helper waits for that view's CSS before it renders).
            {name: 'vendor-primer-react', test: /[\\/]@primer[\\/]react[\\/]/, tags: ['$initial']},
            {name: 'vendor-primer-react-lazy', test: /[\\/]@primer[\\/]react[\\/]/},
            {name: 'vendor-primer-octicons-react', test: /[\\/]@primer[\\/]octicons-react[\\/]/, tags: ['$initial']},
            {name: 'vendor-primer-octicons-react-lazy', test: /[\\/]@primer[\\/]octicons-react[\\/]/},
            // Include only static entry dependencies, plus Vite's preload helper to avoid a cycle through the entry.
            {name: 'app-boot', test: (id) => (/[\\/]src[\\/]/.test(id) && !id.endsWith('/src/main.tsx')) || id.includes('vite/preload-helper'), tags: ['$initial']},
          ],
        },
      },
    },
  },
  // Vite SSR handles Primer's CSS imports, which Node cannot load.
  ssr: {noExternal: [/@primer\/react/]},
  server: {
    port: 5173,
    strictPort: true,
    // Proxy non-UI paths and server endpoints to Forgejo; register this origin's callback in OAUTH_REDIRECT_URIS.
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
