// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import react from '@vitejs/plugin-react';
import {defineConfig} from 'vitest/config';

// One Vitest project per suite. `npm test` runs "unit"; B10 adds a
// "conformance" project (Node environment, conformance/**) next to it.
export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}', 'tools/**/*.test.ts', 'lint/**/*.test.ts'],
          setupFiles: ['src/test/setup.ts'],
        },
      },
    ],
  },
});
