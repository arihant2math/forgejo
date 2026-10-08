// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {BOOT_ROUTES} from './tools/boot.ts';
import {previewConfig} from './tools/vite-plugin-preview-config.ts';
import {shell} from './tools/vite-plugin-shell.ts';
import {serviceWorker} from './tools/vite-plugin-sw.ts';

// Radix primitives the app uses get a chunk each. Radix's internal packages
// (context, presence, popper, focus-scope, …) share one chunk: left to
// Rolldown's default splitting they landed in the boot route's chunk, which
// then formed an import cycle with vendor-radix-ui-tooltip and broke boot
// ("x is not a function"; e2e/boot.spec.ts catches it). The cost: internals
// only a lazy route uses (menu/dialog ones) load at boot too (~5 KB br today).
// floating-ui and react-remove-scroll's dependency tree are each one chunk.
const radixPrimitives = new Set(['tooltip', 'dropdown-menu', 'context-menu', 'menu', 'dialog', 'popover', 'toggle-group', 'toggle']);
// Radix internals only menus and dialogs use (focus trapping, roving focus): their own chunk, off the boot
// route (the tooltip, which the shell needs at boot, uses none of them). They import the shared internals,
// never the other way round, so no chunk cycle (budget.ts fails on one; e2e/boot.spec.ts runs the build).
const radixFocus = new Set(['react-focus-scope', 'react-focus-guards', 'react-roving-focus', 'react-collection', 'react-direction', 'react-use-previous']);
const removeScroll = new Set(['react-remove-scroll', 'react-remove-scroll-bar', 'react-style-singleton', 'use-callback-ref', 'use-sidecar', 'get-nonce', 'detect-node-es', 'tslib']);

/**
 * Per-package vendor chunks (PLAN §1): a dependency update only invalidates its
 * own chunk, and a package only one lazy route uses loads with that route.
 * Icons are not grouped: each lucide icon stays with the route that draws it.
 */
export function vendorChunk(id: string): string | null {
  const m = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id);
  if (!m?.[1]) return null;
  const pkg = m[1].replace('\\', '/');
  if (pkg === 'lucide-react' && /[\\/]icons[\\/]/.test(id)) return null;
  const radix = /^@radix-ui\/react-(.+)$/.exec(pkg);
  if (radix?.[1] && radixPrimitives.has(radix[1])) return `vendor-radix-ui-${radix[1]}`;
  if (pkg.startsWith('@radix-ui/')) return radixFocus.has(pkg.slice('@radix-ui/'.length)) ? 'vendor-radix-ui-focus' : 'vendor-radix-ui-internal';
  if (pkg.startsWith('@floating-ui/')) return 'vendor-floating-ui';
  if (removeScroll.has(pkg)) return 'vendor-react-remove-scroll';
  return `vendor-${pkg.replace(/^@/, '').replace('/', '-')}`;
}

export default defineConfig({
  // Same origin as Forgejo; B8 serves dist/ under /-/next/ (PLAN §4.10).
  base: '/-/next/',
  plugins: [
    react(),
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
      // src/ui modules are pure (components and class tables only), so a feature
      // importing one primitive from the barrel does not pull in the others.
      // Everything else keeps the default: side-effect-only imports still work.
      treeshake: {
        moduleSideEffects: (id: string) => (/[\\/]src[\\/]ui[\\/][^\\/]+\.tsx?$/.test(id) ? false : undefined),
      },
      output: {
        codeSplitting: {
          // Without this, a group also captures its dependencies, e.g. react
          // would land in vendor-lucide-react. Vendor packages here are either
          // side-effect free ESM or lazily initialised CJS wrappers, so splitting
          // them apart cannot reorder side effects (the e2e boot test runs the build).
          includeDependenciesRecursively: false,
          groups: [{name: vendorChunk, debugName: 'vendor'}],
        },
      },
    },
  },
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
