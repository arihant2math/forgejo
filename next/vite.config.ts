// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {BOOT_ROUTES} from './tools/boot.ts';
import {shell} from './tools/vite-plugin-shell.ts';

// Radix primitives the app uses get a chunk each. Radix's internal packages
// (context, presence, popper, focus-scope, …) share one chunk: left to
// Rolldown's default splitting they landed in the boot route's chunk, which
// then formed an import cycle with vendor-radix-ui-tooltip and broke boot
// ("x is not a function"; e2e/boot.spec.ts catches it). The cost: internals
// only a lazy route uses (menu/dialog ones) load at boot too (~5 KB br today).
// floating-ui and react-remove-scroll's dependency tree are each one chunk.
const radixPrimitives = new Set(['tooltip', 'dropdown-menu', 'context-menu', 'menu', 'dialog', 'popover']);
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
  if (pkg.startsWith('@radix-ui/')) return 'vendor-radix-ui-internal';
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
  ],
  css: {
    transformer: 'lightningcss',
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
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
