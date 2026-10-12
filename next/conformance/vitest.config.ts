// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

// Run files serially in name order: they share a server, and the restart test kills it.

import {fileURLToPath} from 'node:url';
import {BaseSequencer, type TestSpecification} from 'vitest/node';
import {defineConfig} from 'vitest/config';

class ByName extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return Promise.resolve([...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)));
  }
}

export default defineConfig({
  cacheDir: fileURLToPath(new URL('../node_modules/.vite', import.meta.url)),
  test: {
    name: 'conformance',
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['*.test.ts'],
    environment: 'node',
    setupFiles: ['../integration/setup.ts', './setup.ts'],
    fileParallelism: false,
    sequence: {sequencer: ByName},
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
