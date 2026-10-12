// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';

// Keep pure tests in Node, without paying for a fresh jsdom per file.
// Include browser-dependent imports too, not only tests that directly use the DOM.
const domTests = [
  'src/**/*.test.tsx',
  ...[
    'sync/client', 'sync/data', 'sync/startup', 'auth/auth', 'sw/routes',
    'app/trusted', 'app/splash', 'app/config', 'app/rum', 'app/routes', 'app/shortcuts/registry',
    'features/issue/markdown', 'features/issues/closed', 'features/issues/list', 'features/views/views',
    'features/editor/preview', 'features/new/forms', 'features/usersettings/data',
    'intents/executor', 'code/logfeed',
  ].map((path) => `src/${path}.test.ts`),
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
