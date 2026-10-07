// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';
import {shell} from './tools/vite-plugin-shell.ts';

/** Per-package vendor chunks (PLAN §1): a dependency update only invalidates its own chunk. */
export function vendorChunk(id: string): string | null {
  const m = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id);
  if (!m?.[1]) return null;
  const pkg = m[1].replace('\\', '/');
  // These scopes release in lockstep and consist of many sub-kilobyte packages:
  // one chunk per scope instead of ~30 tiny requests.
  const scope = /^@(radix-ui|floating-ui)\//.exec(pkg);
  return `vendor-${(scope?.[1] ?? pkg).replace(/^@/, '').replace('/', '-')}`;
}

export default defineConfig({
  // Same origin as Forgejo; B8 serves dist/ under /-/next/ (PLAN §4.10).
  base: '/-/next/',
  plugins: [
    react(),
    tailwindcss(),
    shell({bootRoutes: ['src/features/home/Home.tsx']}),
  ],
  css: {
    transformer: 'lightningcss',
  },
  build: {
    target: 'esnext',
    cssTarget: 'esnext',
    cssMinify: 'lightningcss',
    manifest: true,
    sourcemap: true,
    modulePreload: {polyfill: false},
    reportCompressedSize: false,
    rolldownOptions: {
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
