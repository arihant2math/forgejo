// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// The headless conformance suite (B10, PLAN Phase 1 exit): Node, one file at
// a time in name order (the files share one server; 7-restart.test.ts kills
// and restarts it), against FORGEJO_URL. `npm run test:conformance` from
// next/; `next/tools/dev-forgejo.sh conformance all` starts Forgejo on
// PostgreSQL and on MySQL and runs it against each.

import {fileURLToPath} from 'node:url';
import {BaseSequencer, type TestSpecification} from 'vitest/node';
import {defineConfig} from 'vitest/config';

class ByName extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return Promise.resolve([...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)));
  }
}

export default defineConfig({
  // Vitest's cache next to the other projects' (the root is this directory).
  cacheDir: fileURLToPath(new URL('../node_modules/.vite', import.meta.url)),
  test: {
    name: 'conformance',
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['*.test.ts'],
    environment: 'node',
    setupFiles: ['./setup.ts'],
    fileParallelism: false,
    sequence: {sequencer: ByName},
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
