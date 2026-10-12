// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later

import {afterEach, expect, test, vi} from 'vitest';

afterEach(() => {vi.unstubAllGlobals(); vi.resetModules();});

test('Pierre workers use the app TrustedScriptURL policy below the deployment base', async () => {
  const urls: string[] = [];
  vi.stubGlobal('trustedTypes', {createPolicy: (name: string, rules: {createScriptURL: (url: string) => string}) => {
    expect(name).toBe('forgejo-next');
    return {createScriptURL: (url: string) => {
      urls.push(url);
      return {trusted: rules.createScriptURL(url)};
    }};
  }});
  const construct = vi.fn();
  vi.stubGlobal('Worker', class {
    terminate() { /* Worker test double. */ }
    constructor(url: unknown, options: WorkerOptions) {
      // Model the enforced browser sink: a plain string (or URL) must fail.
      expect(typeof url).toBe('object');
      construct(url, options);
    }
  });
  const {pierreWorker} = await import('./pierreWorker.ts');
  pierreWorker('/next/', '/-/next/assets/worker-123.js', 'diffs-highlight');
  // The dev server serves the worker from outside the build's assets: it stays where it is.
  pierreWorker('/next/', '/node_modules/@pierre/diffs/dist/worker/worker.js?worker_file&type=module', 'diffs-highlight');
  expect(urls).toEqual(['/next/assets/worker-123.js', '/node_modules/@pierre/diffs/dist/worker/worker.js?worker_file&type=module']);
  expect(construct).toHaveBeenCalledTimes(2);
  expect(construct).toHaveBeenLastCalledWith({trusted: urls[1]}, {type: 'module', name: 'diffs-highlight'});
});
