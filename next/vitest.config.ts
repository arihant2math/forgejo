// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import react from '@vitejs/plugin-react';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';

// Pure tests run in Node, without paying for a fresh jsdom per file. Components (.tsx) and .ts tests that need
// browser APIs, directly or through their imports, run in jsdom; the latter say so in a docblock.
const src = fileURLToPath(new URL('src', import.meta.url));
const domTests = [
  'src/**/*.test.tsx',
  ...readdirSync(src, {recursive: true, encoding: 'utf8'})
    .filter((f) => f.endsWith('.test.ts') && /^\/\/ @vitest-environment jsdom$/m.test(readFileSync(join(src, f), 'utf8')))
    .map((f) => `src/${f.replaceAll('\\', '/')}`),
];

export default defineConfig({
  plugins: [react()],
  test: {
    // @primer/react's modules import their stylesheets: let Vite load them (Node cannot import .css).
    server: {deps: {inline: [/@primer\/react/]}},
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          maxWorkers: 4,
          include: ['src/**/*.test.ts', 'tools/**/*.test.ts', 'lint/**/*.test.ts'],
          exclude: domTests,
        },
      },
      {
        extends: true,
        test: {
          name: 'unit-dom',
          environment: 'jsdom',
          // Primer's Node live-region build never defines the element; jsdom needs the browser build.
          alias: {'@primer/live-region-element': fileURLToPath(new URL('node_modules/@primer/live-region-element/dist/esm/index.js', import.meta.url))},
          maxWorkers: 4,
          include: domTests,
          setupFiles: ['src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['integration/**/*.test.ts'],
          setupFiles: ['integration/setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
