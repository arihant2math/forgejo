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
      expect((url as {trusted: string}).trusted).toMatch(/^\/next\/assets\/.*\.js$/);
      construct(url, options);
    }
  });
  const {pierreWorker} = await import('./pierreWorker.ts');
  pierreWorker('/next/', '/assets/diffs.worker-123.js', 'diffs-highlight');
  pierreWorker('/next/', '/assets/pierre.worker-456.js', 'diffs-parse');
  expect(urls).toEqual(['/next/assets/diffs.worker-123.js', '/next/assets/pierre.worker-456.js']);
  expect(construct).toHaveBeenCalledTimes(2);
  expect(construct).toHaveBeenLastCalledWith({trusted: urls[1]}, {type: 'module', name: 'diffs-parse'});
});
