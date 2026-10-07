// Copyright 2026 The Forgejo Authors. All rights reserved.
// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node

import {randomBytes} from 'node:crypto';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, test} from 'vitest';
import {vendorChunk} from '../vite.config.ts';
import {analyze, BUDGET, chunkCycles, cssProblems} from './budget.ts';

describe('vendorChunk', () => {
  test.each([
    ['/x/node_modules/react/index.js', 'vendor-react'],
    ['/x/node_modules/react-dom/cjs/react-dom-client.production.js', 'vendor-react-dom'],
    ['/x/node_modules/@radix-ui/react-dialog/dist/index.mjs', 'vendor-radix-ui-dialog'],
    ['/x/node_modules/@radix-ui/react-presence/dist/index.mjs', 'vendor-radix-ui-internal'],
    ['/x/node_modules/@radix-ui/primitive/dist/index.mjs', 'vendor-radix-ui-internal'],
    ['/x/node_modules/@floating-ui/dom/dist/x.mjs', 'vendor-floating-ui'],
    ['/x/node_modules/get-nonce/dist/es2015/index.js', 'vendor-react-remove-scroll'],
    ['/x/node_modules/lucide-react/dist/esm/icons/plus.js', null],
    ['/x/node_modules/lucide-react/dist/esm/Icon.js', 'vendor-lucide-react'],
    ['/x/node_modules/@tanstack/react-router/dist/esm/index.js', 'vendor-tanstack-react-router'],
    ['/x/node_modules/a/node_modules/b/index.js', 'vendor-a'],
    ['/x/src/main.tsx', null],
  ])('%s → %s', (id, name) => {
    expect(vendorChunk(id)).toBe(name);
  });
});

function dist(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'budget-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), {recursive: true});
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const manifest = (imports: string[]) => JSON.stringify({
  'index.html': {file: 'assets/main.js', isEntry: true, imports, dynamicImports: ['src/Home.tsx']},
  _a: {file: 'assets/a.js'},
  'src/Home.tsx': {file: 'assets/home.js', imports: ['_a']},
});

describe('budget', () => {
  test('counts inline script/style, entry and preloads; passes under budget', () => {
    const r = analyze(dist({
      'index.html': '<script>mark()</script><style>a{}</style><script type="module" crossorigin src="/-/next/assets/main.js"></script><link href="/-/next/assets/a.js" crossorigin rel="modulepreload"><link rel=modulepreload href="/-/next/assets/home.js">',
      'assets/main.js': 'x',
      'assets/a.js': 'y',
      'assets/home.js': 'z',
      '.vite/manifest.json': manifest(['_a']),
    }), '/-/next/', ['src/Home.tsx']);
    expect(r.items.map((i) => i.name)).toEqual(['index.html <script> #1', 'index.html <style> #1', 'assets/main.js', 'assets/a.js', 'assets/home.js']);
    expect(r.problems).toEqual([]);
  });

  test('fails when a static import is not preloaded, and when over budget', () => {
    const noise = randomBytes(BUDGET.js * 2).toString('base64'); // incompressible
    const r = analyze(dist({
      'index.html': '<script type="module" src="/-/next/assets/main.js"></script>',
      'assets/main.js': noise,
      'assets/a.js': 'y',
      'assets/home.js': 'z',
      '.vite/manifest.json': manifest(['_a']),
    }), '/-/next/', ['src/Home.tsx', 'src/Missing.tsx']);
    expect(r.problems).toContain('assets/a.js: needed at boot but not preloaded');
    expect(r.problems).toContain('assets/home.js: needed at boot but not preloaded');
    expect(r.problems).toContain('boot route src/Missing.tsx: no chunk of its own in the manifest');
    expect(r.problems.some((p) => p.startsWith('boot JS'))).toBe(true);
  });

  test('flags banned CSS in the output', () => {
    expect(cssProblems(':root{--color-fg:#fff}.a{background-color:#0000}@property --x{initial-value:#fff}')).toEqual([]);
    expect(cssProblems('.bg-\\[\\#fff\\]{background-color:#fff}.t{transition-property:all}')).toHaveLength(2);
    expect(cssProblems('.a{color:rgb(0 0 0)}.b{transition:height .2s}.c{transition-property:color,background-color,border-color,opacity}')).toHaveLength(2);
  });
});

describe('chunkCycles', () => {
  test('finds a static import cycle between chunks', () => {
    expect(chunkCycles({a: {file: 'a.js', imports: ['b']}, b: {file: 'b.js', imports: ['c']}, c: {file: 'c.js'}})).toEqual([]);
    expect(chunkCycles({a: {file: 'a.js', imports: ['b']}, b: {file: 'b.js', imports: ['a']}})).toEqual(['chunk import cycle: a.js → b.js → a.js']);
  });
});
