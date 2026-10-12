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

/** Split by package so updates invalidate only that chunk and lazy-route dependencies stay lazy. */
export function vendorChunk(id: string): string | null {
  const m = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id);
  if (!m?.[1]) return null;
  const pkg = m[1].replace('\\', '/');
  // React's profiling build (localStorage.profile, app/profile.tsx) loads only when asked: never with react-dom.
  if (pkg === 'react-dom' && id.includes('profiling')) return 'vendor-react-dom-profiling';
  // Keep Primer components and their CSS together so boot routes cannot discover a late stylesheet.
  if (pkg === '@primer/react') return 'vendor-primer-react';
  return `vendor-${pkg.replace(/^@/, '').replace('/', '-')}`;
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
  css: {
    transformer: 'lightningcss',
  },
  // Module workers keep Shiki grammars as lazy imports; IIFE workers would inline them all.
  worker: {
    format: 'es',
    // Cache lang-* grammar chunks on first use; precaching ~3 MB delays offline installation.
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
    // Hidden sourcemaps aid debugging without being referenced, precached or served by default.
    sourcemap: 'hidden',
    modulePreload: {polyfill: false},
    reportCompressedSize: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Do not capture dependencies into unrelated vendor groups; split only side-effect-free or lazy wrappers.
          includeDependenciesRecursively: false,
          groups: [
            {name: vendorChunk, debugName: 'vendor'},
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
